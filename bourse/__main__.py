"""Point d'entrée : `python -m bourse` lance le serveur web."""

import logging

import uvicorn

from . import config
from .db import init_db


def main() -> None:
    logging.basicConfig(level=config.LOG_LEVEL.upper(), format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    init_db()
    uvicorn.run(
        "bourse.app:app",
        host=config.HOST,
        port=config.PORT,
        proxy_headers=True,
        forwarded_allow_ips=config.FORWARDED_ALLOW_IPS,
        ssl_certfile=config.SSL_CERTFILE,
        ssl_keyfile=config.SSL_KEYFILE,
        log_level=config.LOG_LEVEL,
        reload=config.DEBUG,
        server_header=False,
    )


if __name__ == "__main__":
    main()
