FROM debian:8.4

MAINTAINER Guillaume COUPELANT <guillaume.coupelant@gmail.com>

ENV DEBIAN_FRONTEND noninteractive
ARG COMPOSE_VERSION=1.7.1

RUN apt-get update -q \
	&& apt-get install -y -q --no-install-recommends curl ca-certificates \
	&& curl -o /usr/local/bin/docker-compose -L \
		"https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-Linux-x86_64" \
	&& chmod +x /usr/local/bin/docker-compose

# This container is a chrooted docker-compose
WORKDIR /app
ENTRYPOINT ["/usr/local/bin/docker-compose"]
CMD ["--version"]
