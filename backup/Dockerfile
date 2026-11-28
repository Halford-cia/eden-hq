# Image for the Cloud Run jobs eden-backup (worker.mjs) and eden-backup-watch
# (watch.mjs). Built by Cloud Build from the repository root:
#   gcloud builds submit --config backup/cloudbuild.yaml --substitutions _IMAGE=<region>-docker.pkg.dev/<project>/eden/eden-backup:<tag>
# pg_dump must match the server's major version (PostgreSQL 17).
FROM postgres:17.6-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends nodejs npm age ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY backup/ ./backup/

USER postgres
ENTRYPOINT ["node"]
CMD ["backup/worker.mjs"]
