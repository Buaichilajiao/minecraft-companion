# -*- coding: utf-8 -*-
"""输出迷宫的 /fill 区域清单（JSON，喂给 fill-region 工具）。
思路：整块填 bedrock（含天花板层）→ 逐行 run-length 把通道挖成 air（2 格高）→ 顶层层覆成 glass。
用法: python tools/maze_fill_plan.py <X> <Y> <Z>
"""
import sys, json, random

W = H = 17
cells = (W - 1) // 2
WALL_H = 2          # 墙高（通道净高压到 2：跳不过、也没空间搭塔）
CEIL = 'glass'      # 天花板（透明，便于玩家围观；同时封死"搭塔翻墙"）
WALL = 'bedrock'    # 不可挖 → pathfinder 只能真·找路，不能拆墙

rng = random.Random(20260911)
grid = [[1] * W for _ in range(W)]

def carve(i, j):
    grid[2 * j + 1][2 * i + 1] = 0
    dirs = [(1, 0), (-1, 0), (0, 1), (0, -1)]
    rng.shuffle(dirs)
    for dx, dz in dirs:
        ni, nj = i + dx, j + dz
        if 0 <= ni < cells and 0 <= nj < cells and grid[2 * nj + 1][2 * ni + 1] == 1:
            grid[2 * j + 1 + dz][2 * i + 1 + dx] = 0
            carve(ni, nj)

carve(0, 0)
EX, EZ = 2 * (cells - 1) + 1, W - 1
grid[EZ][EX] = 0     # 出口：右下角 cell 向南打通外墙

X, Y, Z = int(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3])
HT = WALL_H + 1

regions = [{'x1': X, 'y1': Y, 'z1': Z, 'x2': X + W - 1, 'y2': Y + HT - 1, 'z2': Z + W - 1, 'block': WALL}]
for z in range(W):
    x = 0
    while x < W:
        if grid[z][x] == 0:
            x0 = x
            while x < W and grid[z][x] == 0:
                x += 1
            regions.append({'x1': X + x0, 'y1': Y, 'z1': Z + z, 'x2': X + x - 1, 'y2': Y + WALL_H - 1, 'z2': Z + z, 'block': 'air'})
        else:
            x += 1
regions.append({'x1': X, 'y1': Y + HT - 1, 'z1': Z, 'x2': X + W - 1, 'y2': Y + HT - 1, 'z2': Z + W - 1, 'block': CEIL})

print(f'# 图纸 {W}x{HT}x{W} @ ({X},{Y},{Z})；墙{WALL} 高{WALL_H} 顶{CEIL}；共 {len(regions)} 条 fill 命令', file=sys.stderr)
print(f'# 起点 (world) = ({X + 1}, {Y}, {Z + 1})', file=sys.stderr)
print(f'# 出口 (world) = ({X + EX}, {Y}, {Z + W + 1})  ← 图纸外一格', file=sys.stderr)
out = json.dumps(regions, separators=(',', ':'))
if len(sys.argv) > 4:
    with open(sys.argv[4], 'w', encoding='utf-8') as f:   # 别用 PS 的 >（会写成 UTF-16，node 读不了）
        f.write(out)
    print(f'# 已写入 {sys.argv[4]}', file=sys.stderr)
else:
    print(out)
