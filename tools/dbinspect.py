import sqlite3
db = r"D:\梦汐启动器\梦汐Bot启动器\AstrBot\AstrBot\data\data_v4.db"
con = sqlite3.connect(db); cur = con.cursor()
cols = [c[1] for c in cur.execute("PRAGMA table_info(umo_aliases)")]
print("umo_aliases cols:", cols)
rows = list(cur.execute("SELECT * FROM umo_aliases"))
print("count:", len(rows))
for r in rows[:40]:
    print(r)
con.close()
