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
# At DNS cutover: set enable_frontdoor = true, apply, then add the custom-domain
# + CNAME bindings for api / auth / mcp.
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

output "frontdoor_endpoint" {
  description = "Front Door hostname, null while enable_frontdoor is false."
  value       = var.enable_frontdoor ? azurerm_cdn_frontdoor_endpoint.api[0].host_name : null
}
