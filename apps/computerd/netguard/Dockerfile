FROM alpine:3.23

RUN apk add --no-cache iptables ip6tables

COPY --chmod=0755 netguard.sh /netguard.sh

ENTRYPOINT ["/netguard.sh"]
