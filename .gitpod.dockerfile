FROM gitpod/workspace-node
FROM postgres:16

# Variables needed at runtime to configure postgres
ENV POSTGRES_DB 'postgres'
ENV POSTGRES_USER 'postgres'
ENV POSTGRES_PASSWORD 'postgres'
