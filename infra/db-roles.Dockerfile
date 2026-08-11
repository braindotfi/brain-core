# db-roles job image.
#
# A Container App Job cannot bind-mount infra/db-roles.sql the way compose does,
# so the SQL is baked in. The base image is used purely for its psql client,
# matching the compose service it replaces.
#
# NOTE the build context is `infra/`, NOT the repo root: the root .dockerignore
# excludes `infra`, so a root-context build cannot see db-roles.sql at all.
#
#   docker build -f infra/db-roles.Dockerfile -t brain-db-roles:latest infra/
#   az acr build --registry <acr> --image brain-db-roles:latest \
#       --file db-roles.Dockerfile infra/

FROM pgvector/pgvector:pg16

COPY db-roles.sql /db-roles.sql
COPY db-roles-entrypoint.sh /db-roles-entrypoint.sh

RUN chmod +x /db-roles-entrypoint.sh

ENTRYPOINT ["/db-roles-entrypoint.sh"]
