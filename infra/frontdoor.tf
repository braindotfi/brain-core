# ---------------------------------------------------------------------------
# Front Door (blocker #8)
#
# The scaffold created a profile and stopped, leaving a billed resource with no
# endpoint, origin, or route -- it fronted nothing.
#
# Everything here is gated on var.enable_frontdoor, default false. DNS is
# deferred, and Front Door in front of no hostname is cost without function. The
# Container Apps ingress FQDN already terminates HTTPS with a managed
# certificate, which is sufficient to verify the stack end to end.
#
# Front Door exists here for exactly one reason: mcp.brain.fi needs a path
# rewrite (`/` -> `/v1/agents/mcp`) and Container Apps ingress cannot rewrite
# paths. On the VM that rewrite lives in an unversioned Caddyfile. api.brain.fi
# and auth.brain.fi do not need it and CNAME straight at Container Apps.
#
# At DNS cutover: set frontdoor_mcp_custom_domain = "mcp.brain.fi", apply,
# publish the _dnsauth TXT from the frontdoor_mcp_domain_validation_token
# output, wait for the managed certificate, then move the record.
# ---------------------------------------------------------------------------

resource "azurerm_cdn_frontdoor_profile" "main" {
  count               = var.enable_frontdoor ? 1 : 0
  name                = "${local.name_prefix}-fd"
  resource_group_name = azurerm_resource_group.primary.name
  sku_name            = var.frontdoor_sku_name
  tags                = local.tags
}

resource "azurerm_cdn_frontdoor_endpoint" "api" {
  count                    = var.enable_frontdoor ? 1 : 0
  name                     = "${local.name_prefix}-api"
  cdn_frontdoor_profile_id = azurerm_cdn_frontdoor_profile.main[0].id
  tags                     = local.tags
}

resource "azurerm_cdn_frontdoor_origin_group" "api" {
  count                    = var.enable_frontdoor ? 1 : 0
  name                     = "${local.name_prefix}-api-origins"
  cdn_frontdoor_profile_id = azurerm_cdn_frontdoor_profile.main[0].id

  load_balancing {
    sample_size                 = 4
    successful_samples_required = 3
  }

  health_probe {
    path                = "/health"
    protocol            = "Https"
    request_type        = "GET"
    interval_in_seconds = 30
  }
}

resource "azurerm_cdn_frontdoor_origin" "api" {
  count                          = var.enable_frontdoor ? 1 : 0
  name                           = "${local.name_prefix}-api-origin"
  cdn_frontdoor_origin_group_id  = azurerm_cdn_frontdoor_origin_group.api[0].id
  enabled                        = true
  host_name                      = azurerm_container_app.api.ingress[0].fqdn
  origin_host_header             = azurerm_container_app.api.ingress[0].fqdn
  http_port                      = 80
  https_port                     = 443
  priority                       = 1
  weight                         = 1000
  certificate_name_check_enabled = true
}

resource "azurerm_cdn_frontdoor_route" "api" {
  count                         = var.enable_frontdoor ? 1 : 0
  name                          = "${local.name_prefix}-api-route"
  cdn_frontdoor_endpoint_id     = azurerm_cdn_frontdoor_endpoint.api[0].id
  cdn_frontdoor_origin_group_id = azurerm_cdn_frontdoor_origin_group.api[0].id
  cdn_frontdoor_origin_ids      = [azurerm_cdn_frontdoor_origin.api[0].id]

  supported_protocols    = ["Http", "Https"]
  patterns_to_match      = ["/*"]
  forwarding_protocol    = "HttpsOnly"
  https_redirect_enabled = true
  link_to_default_domain = true
}

# ---------------------------------------------------------------------------
# mcp.brain.fi — the path rewrite Container Apps ingress cannot do
#
# Same origin as the api route above (mcp IS the api app); a separate endpoint
# so the rewrite rule set applies only to mcp traffic and never to api.brain.fi.
# The endpoint gives a real HTTPS hostname to curl before any DNS moves.
#
# MCP_PUBLIC_RESOURCE_URL is deliberately unset (shared/src/config.ts defaults
# it to https://mcp.brain.fi). Do NOT point it at the Front Door hostname: it is
# the OAuth resource identifier clients discover, and a mismatch fails auth in a
# way that reads as a permissions bug.
# ---------------------------------------------------------------------------

resource "azurerm_cdn_frontdoor_endpoint" "mcp" {
  count                    = var.enable_frontdoor ? 1 : 0
  name                     = "${local.name_prefix}-mcp"
  cdn_frontdoor_profile_id = azurerm_cdn_frontdoor_profile.main[0].id
  tags                     = local.tags
}

resource "azurerm_cdn_frontdoor_rule_set" "mcp" {
  count                    = var.enable_frontdoor ? 1 : 0
  name                     = "mcprewrite"
  cdn_frontdoor_profile_id = azurerm_cdn_frontdoor_profile.main[0].id
}

# Mirrors the VM's Caddy config: rewrite the root only. /health and
# /.well-known/oauth-protected-resource must pass through untouched -- the
# discovery document is what MCP clients fetch to find the authorization server.
resource "azurerm_cdn_frontdoor_rule" "mcp_root" {
  count                     = var.enable_frontdoor ? 1 : 0
  name                      = "mcprootrewrite"
  cdn_frontdoor_rule_set_id = azurerm_cdn_frontdoor_rule_set.mcp[0].id
  order                     = 1
  behavior_on_match         = "Stop"

  # Front Door's UrlPath condition is documented as the path *without* the
  # leading slash, but the portal and API both accept "/". Matching both spellings
  # means the rule cannot silently fail to fire against either semantics -- and a
  # rule that does not fire looks like a working 401, because the api 401s on
  # every unknown path too.
  conditions {
    url_path_condition {
      operator     = "Equal"
      match_values = ["/", ""]
    }
  }

  actions {
    url_rewrite_action {
      source_pattern          = "/"
      destination             = "/v1/agents/mcp"
      preserve_unmatched_path = false
    }
  }

  depends_on = [azurerm_cdn_frontdoor_origin_group.api, azurerm_cdn_frontdoor_origin.api]
}

resource "azurerm_cdn_frontdoor_route" "mcp" {
  count                         = var.enable_frontdoor ? 1 : 0
  name                          = "${local.name_prefix}-mcp-route"
  cdn_frontdoor_endpoint_id     = azurerm_cdn_frontdoor_endpoint.mcp[0].id
  cdn_frontdoor_origin_group_id = azurerm_cdn_frontdoor_origin_group.api[0].id
  cdn_frontdoor_origin_ids      = [azurerm_cdn_frontdoor_origin.api[0].id]
  cdn_frontdoor_rule_set_ids    = [azurerm_cdn_frontdoor_rule_set.mcp[0].id]

  supported_protocols    = ["Http", "Https"]
  patterns_to_match      = ["/*"]
  forwarding_protocol    = "HttpsOnly"
  https_redirect_enabled = true
  link_to_default_domain = true

  # MCP is JSON-RPC over POST and its GET surfaces are per-token. No cache block
  # means caching stays off, which is the only correct setting here.

  cdn_frontdoor_custom_domain_ids = var.frontdoor_mcp_custom_domain == "" ? [] : [azurerm_cdn_frontdoor_custom_domain.mcp[0].id]
}

# Created only once a hostname is named. Front Door validates ownership from the
# _dnsauth TXT record alone, so the managed certificate can be issued while the A
# record still points at the VM -- that is what makes the cutover rehearsable
# rather than a leap. Container Apps custom domains cannot do this: their managed
# cert is issued only after the CNAME already resolves to the app.
resource "azurerm_cdn_frontdoor_custom_domain" "mcp" {
  count                    = var.enable_frontdoor && var.frontdoor_mcp_custom_domain != "" ? 1 : 0
  name                     = "mcp"
  cdn_frontdoor_profile_id = azurerm_cdn_frontdoor_profile.main[0].id
  host_name                = var.frontdoor_mcp_custom_domain

  tls {
    certificate_type = "ManagedCertificate"
    minimum_version  = "TLS12"
  }
}

output "frontdoor_endpoint" {
  description = "Front Door hostname, null while enable_frontdoor is false."
  value       = var.enable_frontdoor ? azurerm_cdn_frontdoor_endpoint.api[0].host_name : null
}

output "frontdoor_mcp_endpoint" {
  description = "Front Door hostname serving the mcp rewrite. Curl this before moving DNS."
  value       = var.enable_frontdoor ? azurerm_cdn_frontdoor_endpoint.mcp[0].host_name : null
}

output "frontdoor_mcp_domain_validation_token" {
  description = "Value for the _dnsauth.mcp TXT record at Name.com. Null until frontdoor_mcp_custom_domain is set."
  value       = var.enable_frontdoor && var.frontdoor_mcp_custom_domain != "" ? azurerm_cdn_frontdoor_custom_domain.mcp[0].validation_token : null
}
