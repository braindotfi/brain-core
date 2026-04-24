# Brain infrastructure — Azure.
# Primary region: East US. DR: West US 3.
# Resources land in stage-8. This file is intentionally a placeholder so
# `terraform validate` runs cleanly in CI against an empty scaffold.

# See Brain_Claude_Code_Prompt.docx Stage 8 for the full inventory:
#   - Resource group (East US) + backup (West US 3)
#   - Container Apps environment with managed identity
#   - Azure Database for PostgreSQL flexible server + pgvector
#   - Azure Cache for Redis
#   - Azure Blob Storage with immutable blob policies
#   - Azure Key Vault with managed-identity access
#   - Azure Container Registry
#   - Azure Front Door
#   - Datadog / Azure Monitor integration
