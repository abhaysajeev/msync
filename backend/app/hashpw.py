"""Print an argon2 hash for ADMIN_PASSWORD_HASH:  python -m app.hashpw"""
import getpass

from argon2 import PasswordHasher

if __name__ == "__main__":
    pw = getpass.getpass("Admin password: ")
    if pw != getpass.getpass("Again: "):
        raise SystemExit("Passwords differ.")
    if len(pw) < 10:
        raise SystemExit("Use at least 10 characters.")
    # single quotes keep docker compose from expanding the $ signs in .env
    print(f"ADMIN_PASSWORD_HASH='{PasswordHasher().hash(pw)}'")
