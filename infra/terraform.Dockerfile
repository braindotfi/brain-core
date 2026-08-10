# In-VNet Terraform runner.
#
#   docker build -f infra/terraform.Dockerfile -t brain-terraform:<sha> infra/
#
# Built with `infra/` as its context (the repo-root .dockerignore excludes
# infra), and the config is COPYed in so the image is pinned to a reviewed
# commit -- no repo clone, no token inside the job.
FROM hashicorp/terraform:1.13

RUN apk add --no-cache bash

WORKDIR /infra
COPY *.tf ./
COPY *.tfvars ./
COPY *.hcl ./
COPY run.sh /run.sh
RUN chmod +x /run.sh

ENTRYPOINT ["/run.sh"]
