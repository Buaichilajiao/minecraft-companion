# -*- coding: utf-8 -*-
"""生成 Sponge Schematic v2 (.schem) 迷宫图纸（供 minecraft-companion build-schem 建造）
布局：17x3x17，墙 = bedrock（不可挖），天花板 = glass（净高 2，不能搭塔/跳过）
出口：右下角 cell 向南打通外墙，通向图纸外一格。"""
import struct, gzip, random, sys, os

W = H = 17          # 图纸宽/长（cells 8x8）
HT = 3              # 图纸高：0,1 = 墙层；2 = 玻璃天花板
cells = (W - 1) // 2

rng = random.Random(20260911)
# 0 = 通道(air)，1 = 墙(bedrock)
grid = [[1] * W for _ in range(W)]

def carve(i, j):
    grid[2 * j + 1][2 * i + 1] = 0
    dirs = [(1, 0), (-1, 0), (0, 1), (0, -1)]
    rng.shuffle(dirs)
    for dx, dz in dirs:
        ni, nj = i + dx, j + dz
        if 0 <= ni < cells and 0 <= nj < cells and grid[2 * nj + 1][2 * ni + 1] == 1:
            # 中间墙 = 两个 cell 的中点：原 cell (i,j) 在 (2i+1,2j+1)，邻居在 (2i+1+2dx, 2j+1+2dz)
            grid[2 * j + 1 + dz][2 * i + 1 + dx] = 0
            carve(ni, nj)

carve(0, 0)

# 出口：cell(7,7) 的南墙（x=15, z=16）打通 → 通向图纸外
EX, EZ = 2 * (cells - 1) + 1, W - 1
grid[EZ][EX] = 0
START = (1, 1)      # 起点图纸坐标（左上 cell）
GOAL_OUT = (EX, W + 1)  # 图纸外的目标（世界坐标里就是 Z+18）

# ── 各层方块：索引 (y * Length + z) * Width + x ──
PALETTE = {'minecraft:air': 0, 'minecraft:bedrock': 1, 'minecraft:glass': 2}
data = []
for y in range(HT):
    for z in range(W):
        for x in range(W):
            if y == HT - 1:
                data.append(PALETTE['minecraft:glass'])
            elif grid[z][x] == 1:
                data.append(PALETTE['minecraft:bedrock'])
            else:
                data.append(PALETTE['minecraft:air'])

def varint(n):
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)

def name(s):
    b = s.encode()
    return struct.pack('>H', len(b)) + b

def tag(t, nm, payload):
    return struct.pack('>B', t) + name(nm) + payload

def t_int(nm, v):   return tag(3, nm, struct.pack('>i', v))
def t_short(nm, v): return tag(2, nm, struct.pack('>h', v))
def t_str(nm, v):   return tag(8, nm, name(v))
def t_iarr(nm, vs): return tag(11, nm, struct.pack('>i', len(vs)) + b''.join(struct.pack('>i', v) for v in vs))
def t_barr(nm, bs): return tag(7, nm, struct.pack('>i', len(bs)) + bs)
def t_comp(nm, body): return tag(10, nm, body) + b'\x00'

palette_body = b''.join(t_int(k, v) for k, v in PALETTE.items())
meta_body = t_int('WEOffsetX', 0) + t_int('WEOffsetY', 0) + t_int('WEOffsetZ', 0)
schem_body = (
    t_int('Version', 2)
    + t_int('DataVersion', 3955)
    + t_short('Width', W) + t_short('Height', HT) + t_short('Length', W)
    + t_iarr('Offset', [0, 0, 0])
    + t_int('PaletteMax', len(PALETTE))
    + t_comp('Palette', palette_body)
    + t_barr('BlockData', b''.join(varint(v) for v in data))
    + t_comp('Metadata', meta_body)
)
root = t_comp('Schematic', schem_body)

out = sys.argv[1] if len(sys.argv) > 1 else 'maze.schem'
with gzip.open(out, 'wb') as f:
    f.write(root)
print('written', out, os.path.getsize(out), 'bytes; size', W, HT, W)

# ── BFS 理论最短路径（从起点到出口）──
from collections import deque
Q = deque([(START[0], START[1], 0)])
seen = {START}
best = None
while Q:
    x, z, d = Q.popleft()
    if (x, z) == (EX, EZ):
        best = d
        break
    for dx, dz in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        nx, nz = x + dx, z + dz
        if 0 <= nx < W and 0 <= nz < W and grid[nz][nx] == 0 and (nx, nz) not in seen:
            seen.add((nx, nz))
            Q.append((nx, nz, d + 1))
print('理论最短（图纸内）：', best, '格')

for z in range(W):
    print(''.join('  ' if grid[z][x] == 0 else '██' for x in range(W)))
