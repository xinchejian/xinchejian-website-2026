#!/usr/bin/env bash
# Load the WordPress database from a mysqldump into a local MariaDB/MySQL.
#
# The production dump was taken with --all-databases, so it also contains the
# server's `mysql` system schema (user accounts and password hashes). Only the
# WordPress schema is loaded.
#
# Usage: scripts/wp-import/load-dump.sh <dump.sql[.gz]> [database-in-dump]
# Connection: the usual mysql client options via MYSQL_ARGS, e.g.
#   MYSQL_ARGS="-h 127.0.0.1 -P 3306 -u root" scripts/wp-import/load-dump.sh xcj-2026.sql
set -euo pipefail

dump="${1:?usage: load-dump.sh <dump.sql[.gz]> [database]}"
db="${2:-wordpress}"
mysql_args=(${MYSQL_ARGS:-})

reader=(cat)
[[ "$dump" == *.gz ]] && reader=(gunzip -c)

mysql "${mysql_args[@]}" -e "DROP DATABASE IF EXISTS \`$db\`; CREATE DATABASE \`$db\` CHARACTER SET utf8mb4"

# A single-database dump has no "Current Database" markers; keep everything.
if "${reader[@]}" "$dump" | grep -q '^-- Current Database:'; then
	filter=(awk -v db="$db" '/^-- Current Database: `/ { keep = ($0 ~ "`" db "`") } keep')
else
	filter=(cat)
fi

{
	echo "SET FOREIGN_KEY_CHECKS=0;"
	"${reader[@]}" "$dump" | "${filter[@]}" | grep -v '^USE `' | grep -v '^CREATE DATABASE' | grep -v 'TIME_ZONE=@OLD_TIME_ZONE'
} | mysql "${mysql_args[@]}" "$db"

mysql "${mysql_args[@]}" "$db" -N -e "SELECT CONCAT(COUNT(*), ' published posts/pages') FROM wp_posts WHERE post_status='publish' AND post_type IN ('post','page')"
