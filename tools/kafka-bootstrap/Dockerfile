# syntax=docker/dockerfile:1
#
# Build context is the repo root, matching every service image.
#
# This runs once per stack start and exits. Topics are created explicitly because auto-creation
# makes them with one partition, which throws away the only parallelism the keying was designed
# to buy — and does it silently. Every client has `allowAutoTopicCreation: false`, so a service
# that starts before this has run fails loudly instead.

FROM node:20-alpine
WORKDIR /repo/tools/kafka-bootstrap

COPY tools/kafka-bootstrap/package.json tools/kafka-bootstrap/package-lock.json ./
RUN npm install --no-audit --no-fund

COPY tools/kafka-bootstrap/ ./

USER node
CMD ["npm", "run", "bootstrap"]
