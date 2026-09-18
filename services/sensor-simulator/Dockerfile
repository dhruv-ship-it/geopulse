# syntax=docker/dockerfile:1
#
# Build context is the REPO ROOT, not this directory. Every service resolves the shared packages
# through `file:../../packages/...`, which npm links by path, so a context rooted at the service
# cannot see them. `.dockerignore` at the root is what keeps that context small.

FROM node:20-alpine AS build
WORKDIR /repo


# Manifests before sources, so a source edit reuses the install layer.
COPY services/sensor-simulator/package.json services/sensor-simulator/package-lock.json ./services/sensor-simulator/
RUN cd services/sensor-simulator && npm install --no-audit --no-fund

COPY services/sensor-simulator/ ./services/sensor-simulator/
RUN cd services/sensor-simulator && npm run build

# Drop the test and build-time dependencies now that dist/ exists. Not a separate runtime stage:
# the `file:` links point out of the service into /repo/packages, and copying a tree of symlinks
# between stages is a good way to ship an image that is subtly missing a module.
RUN cd services/sensor-simulator && npm prune --omit=dev

FROM node:20-alpine AS runtime
WORKDIR /repo/services/sensor-simulator

# Not root. Nothing here needs to be, and the node image already ships a `node` user.
COPY --from=build --chown=node:node /repo /repo
USER node

ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
