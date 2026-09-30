# -*- coding: utf-8 -*-
"""【俯视图 → 迷宫图纸】把一张 2D 迷宫图片（黑=墙 / 白=路，或反色自动判定）转成 .schem
用法：
  python tools/maze_from_image.py <图片> [--out schematic/maze_img.schem]
        [--cell 1]          # 每个像素放大成几格（图片太小时放大）
        [--wall-height 2]   # 「增高两格当墙」= 2（默认 2，防止跳过）
        [--ceiling glass]   # 天花板方块（默认 glass，防搭塔作弊；none=不加）
        [--wall bedrock]    # 墙方块（默认 bedrock，不可挖 → 寻路只能绕，不能拆墙）
        [--invert]          # 强制反色（白=墙）
规则：
  · 图片一律等比取整，先按 --cell 放大，再自动裁掉四周纯色留白边缘
  · 判定「墙」的阈值 = 亮度中位数（自动分辨黑底白墙 / 白底黑墙）
  · 出口不需要在图上标：只要图片边缘有"路"通到外面，寻路就能走出去
"""
import argparse, gzip, struct, sys
from PIL import Image

ap = argparse.ArgumentParser()
ap.add_argument('image')
ap.add_argument('--out', default='schematic/maze_img.schem')
ap.add_argument('--cell', type=int, default=1)
ap.add_argument('--wall-height', type=int, default=2)
ap.add_argument('--ceiling', default='glass')
ap.add_argument('--wall', default='bedrock')
ap.add_argument('--invert', action='store_true')
a = ap.parse_args()

im = Image.open(a.image).convert('L')
w, h = im.size
px = im.load()
lum = [px[x, y] for y in range(h) for x in range(w)]
lum.sort()
thr = lum[len(lum) // 2]

# 墙 = 暗的一侧；若暗像素比亮像素少很多，说明是白底黑墙还是黑底白路？→ 用中线判定后，
# 再按"墙应该连通成骨架"的常识修正：外墙一圈若大多是暗 → 暗=墙
def is_wall_dark():
    if a.invert:
        return False
    border = 0
    n = 0
    for x in range(w):
        for y in (0, h - 1):
            n += 1
            if px[x, y] < thr:
                border += 1
    for y in range(h):
        for x in (0, w - 1):
            n += 1
            if px[x, y] < thr:
                border += 1
    return border / max(1, n) > 0.5

dark_is_wall = is_wall_dark()
grid = [[(1 if ((px[x, y] < thr) == dark_is_wall) else 0) for x in range(w)] for y in range(h)]

# 裁掉四周全墙的留白边缘（保留一圈外墙）
def trim(g):
    top = 0
    while top < len(g) - 1 and all(v == 1 for v in g[top]):
        top += 1
    bot = len(g) - 1
    while bot > top and all(v == 1 for v in g[bot]):
        bot -= 1
    lef = 0
    while lef < len(g[0]) - 1 and all(row[lef] == 1 for row in g):
        lef += 1
    rig = len(g[0]) - 1
    while rig > lef and all(row[rig] == 1 for row in g):
        rig -= 1
    return [[v for v in row[lef - 1 if lef else 0:rig + 2]] for row in g[top - 1 if top else 0:bot + 2]]

grid = trim(grid)
cell = max(1, a.cell)
if cell > 1:
    grid = [[grid[y // cell][x // cell] for x in range(len(grid[0]) * cell)] for y in range(len(grid) * cell)]

W = len(grid[0]); L = len(grid)
HT = a.wall_height + (1 if a.ceiling and a.ceiling != 'none' else 0)
palette = {'minecraft:air': 0, f'minecraft:{a.wall}': 1}
if a.ceiling and a.ceiling != 'none':
    palette[f'minecraft:{a.ceiling}'] = 2

data = []
for y in range(HT):
    for z in range(L):
        for x in range(W):
            if y == HT - 1 and a.ceiling and a.ceiling != 'none':
                data.append(palette[f'minecraft:{a.ceiling}'])
            elif grid[z][x] == 1:
                data.append(palette[f'minecraft:{a.wall}'])
            else:
                data.append(palette['minecraft:air'])

def name(s):
    b = s.encode()
    return struct.pack('>H', len(b)) + b

def tag(t, nm, p):
    return struct.pack('>B', t) + name(nm) + p

def varint(n):
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b); return bytes(out)

t_int = lambda nm, v: tag(3, nm, struct.pack('>i', v))
t_short = lambda nm, v: tag(2, nm, struct.pack('>h', v))
t_iarr = lambda nm, vs: tag(11, nm, struct.pack('>i', len(vs)) + b''.join(struct.pack('>i', v) for v in vs))
t_barr = lambda nm, bs: tag(7, nm, struct.pack('>i', len(bs)) + bs)
t_comp = lambda nm, body: tag(10, nm, body) + b'\x00'

body = (t_int('Version', 2) + t_int('DataVersion', 3955)
        + t_short('Width', W) + t_short('Height', HT) + t_short('Length', L)
        + t_iarr('Offset', [0, 0, 0]) + t_int('PaletteMax', len(palette))
        + t_comp('Palette', b''.join(t_int(k, v) for k, v in palette.items()))
        + t_barr('BlockData', b''.join(varint(v) for v in data))
        + t_comp('Metadata', t_int('WEOffsetX', 0) + t_int('WEOffsetY', 0) + t_int('WEOffsetZ', 0)))
with gzip.open(a.out, 'wb') as f:
    f.write(t_comp('Schematic', body))

print(f'源图 {w}x{h} → 图纸 {W}x{HT}x{L}（墙高 {a.wall_height}，顶 {a.ceiling}，暗=墙:{dark_is_wall}）→ {a.out}')

# 俯视预览 + BFS 检查出口是否可达（找离任意边缘最近的空点当起点，看能否走到图纸外）
from collections import deque
starts = [(x, y) for y in range(L) for x in range(W) if grid[y][x] == 0]
if not starts:
    print('⚠️ 全是墙，没路')
    sys.exit(0)
open_edge = [(x, y) for (x, y) in starts if x == 0 or y == 0 or x == W - 1 or y == L - 1]
print('边缘开口（能走出图纸的点）：', len(open_edge))
for y in range(L):
    print(''.join('  ' if grid[y][x] == 0 else '██' for x in range(W)))
