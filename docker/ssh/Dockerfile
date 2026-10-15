# Test-only SSH bastion for the MySQL tunnel tests. User dev / dev, password and key auth,
# TCP forwarding to any target (the compose network reaches MySQL as mysql:3306).
# Never expose it beyond 127.0.0.1.
FROM alpine:3.20

RUN apk add --no-cache openssh-server \
    && ssh-keygen -A \
    && adduser -D -s /bin/sh dev \
    && echo 'dev:dev' | chpasswd \
    && printf '%s\n' \
        'PasswordAuthentication yes' \
        'KbdInteractiveAuthentication no' \
        'PubkeyAuthentication yes' \
        'PermitRootLogin no' \
        'AllowTcpForwarding yes' \
        'PermitOpen any' \
        'AllowAgentForwarding no' \
        'X11Forwarding no' \
        > /etc/ssh/sshd_config.d/dbclient-test.conf \
    && grep -q '^Include /etc/ssh/sshd_config.d/\*.conf' /etc/ssh/sshd_config \
    || sed -i '1i Include /etc/ssh/sshd_config.d/*.conf' /etc/ssh/sshd_config

EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
