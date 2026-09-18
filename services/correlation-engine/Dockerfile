# syntax=docker/dockerfile:1
#
# Build context is the REPO ROOT, not this directory. Every service resolves the shared packages
# through `file:../../packages/...`, which npm links by path, so a context rooted at the service
# cannot see them. `.dockerignore` at the root is what keeps that context small.

FROM node:20-alpine AS build
WORKDIR /repo

# The shared packages first. They are `file:` dependencies, so npm links them from this
# exact relative path and they have to exist before the service installs — and their own
# `prepare` script builds them, which is the step a "cannot find module '@geopulse/...'"
# error means was skipped. Copied in their own layer so editing the service does not
# rebuild them.
COPY packages/spatial/ ./packages/spatial/
RUN cd packages/spatial && npm install --no-audit --no-fund

# Manifests before sources, so a source edit reuses the install layer.
COPY services/correlation-engine/package.json services/correlation-engine/package-lock.json ./services/correlation-engine/
RUN cd services/correlation-engine && npm install --no-audit --no-fund

COPY services/correlation-engine/ ./services/correlation-engine/
RUN cd services/correlation-engine && npm run build

# Drop the test and build-time dependencies now that dist/ exists. Not a separate runtime stage:
# the `file:` links point out of the service into /repo/packages, and copying a tree of symlinks
# between stages is a good way to ship an image that is subtly missing a module.
RUN cd services/correlation-engine && npm prune --omit=dev

FROM node:20-alpine AS runtime
WORKDIR /repo/services/correlation-engine

# Not root. Nothing here needs to be, and the node image already ships a `node` user.
COPY --from=build --chown=node:node /repo /repo
USER node

ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
