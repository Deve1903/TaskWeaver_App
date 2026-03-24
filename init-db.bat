@echo off
echo Creating TaskWeaver Database...
sqlite3 database.sqlite < schema.sql
echo Database created successfully!
echo Seeding data...
sqlite3 database.sqlite < seed.sql
echo Seed data complete!
pause