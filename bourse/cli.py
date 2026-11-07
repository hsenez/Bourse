"""Gestion des comptes en ligne de commande.

    python -m bourse.cli adduser <nom> [--admin]
    python -m bourse.cli passwd <nom>
    python -m bourse.cli deluser <nom>
    python -m bourse.cli admin <nom> [--off]
    python -m bourse.cli users

Les comptes peuvent aussi être gérés depuis l'interface web (menu du compte > Utilisateurs, administrateurs).
"""

import argparse
import getpass
import sys
from datetime import datetime

from . import auth
from .db import init_db


def _ask_password() -> str:
    while True:
        pw = getpass.getpass("Mot de passe : ")
        if getpass.getpass("Confirmation : ") == pw:
            return pw
        print("Les mots de passe ne correspondent pas, recommencez.")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m bourse.cli", description="Gestion des utilisateurs de Bourse")
    sub = parser.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("adduser", help="créer un utilisateur")
    p.add_argument("username")
    p.add_argument("--admin", action="store_true")
    sub.add_parser("passwd", help="changer un mot de passe").add_argument("username")
    sub.add_parser("deluser", help="supprimer un utilisateur").add_argument("username")
    p = sub.add_parser("admin", help="donner (ou retirer avec --off) les droits d'administration")
    p.add_argument("username")
    p.add_argument("--off", action="store_true")
    sub.add_parser("users", help="lister les utilisateurs")
    args = parser.parse_args(argv)

    init_db()
    try:
        if args.cmd == "adduser":
            auth.create_user(args.username, _ask_password(), args.admin)
            print(f"Utilisateur « {args.username} » créé.")
        elif args.cmd == "passwd":
            auth.update_user(auth.user_id_by_name(args.username), password=_ask_password())
            print("Mot de passe modifié (toutes les sessions de cet utilisateur ont été fermées).")
        elif args.cmd == "deluser":
            if input(f"Supprimer « {args.username} » et ses favoris ? [o/N] ").strip().lower() != "o":
                return 1
            auth.delete_user(auth.user_id_by_name(args.username))
            print("Supprimé.")
        elif args.cmd == "admin":
            auth.update_user(auth.user_id_by_name(args.username), is_admin=not args.off)
            print(f"« {args.username} » {'n’est plus' if args.off else 'est maintenant'} administrateur.")
        elif args.cmd == "users":
            users = auth.list_users()
            if not users:
                print("Aucun utilisateur. Créez-en un avec : python -m bourse.cli adduser <nom>")
            for u in users:
                created = datetime.fromtimestamp(u["created_at"]).strftime("%Y-%m-%d")
                last = (datetime.fromtimestamp(u["last_login_at"]).strftime("%Y-%m-%d %H:%M")
                        if u["last_login_at"] else "jamais")
                print(f"{u['username']:<20} {'admin' if u['is_admin'] else '':<6} créé le {created}  "
                      f"dernière connexion : {last:<16}  {u['favorites']} favori(s)  {u['sessions']} session(s)")
    except auth.AuthError as exc:
        print(f"Erreur : {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
