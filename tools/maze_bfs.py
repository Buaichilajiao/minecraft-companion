# -*- coding: utf-8 -*-
"""BFS 迷宫真实路径长度：用于判断 pathfinder 能处理多长的绕路。
用法: python tools/maze_bfs.py <图纸X> <图纸Z>
"""
import sys, collections

W = 17
cells = (W - 1) // 2
import random
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
grid[EZ][EX] = 0

X, Z = int(sys.argv[1]), int(sys.argv[2])
start = (1, 1)
dist = {start: 0}
q = collections.deque([start])
while q:
    x, z = q.popleft()
    for dx, dz in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        nx, nz = x + dx, z + dz
        if 0 <= nx < W and 0 <= nz < W and grid[nz][nx] == 0 and (nx, nz) not in dist:
            dist[(nx, nz)] = dist[(x, z)] + 1
            q.append((nx, nz))

exit_pt = (EX, EZ)
print(f'起点(图纸) {(1,1)} → 出口 {(EX,EZ)}：最短路径 {dist.get(exit_pt)} 步（直线距离仅 {abs(EX-1)+abs(EZ-1)}）', file=sys.stderr)
print(f'可达格数 {len(dist)}（图纸空格 {sum(r.count(0) for r in grid)}）', file=sys.stderr)
print('按路径长度分档的测试目标：', file=sys.stderr)
buckets = {}
for (x, z), d in sorted(dist.items(), key=lambda kv: kv[1]):
    b = (d // 10) * 10
    buckets.setdefault(b, (x, z, d))
for b, (x, z, d) in sorted(buckets.items()):
    print(f'  路径≈{d:3d} 步 → 世界坐标 ({X + x}, -60, {Z + z})', file=sys.stderr)
print(f'  出口           → 世界坐标 ({X + EX}, -60, {Z + EZ + 1})', file=sys.stderr)
