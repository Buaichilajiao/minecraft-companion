# -*- coding: utf-8 -*-
# 精确替换 helpers.ts 中的 creativeFlyTo 函数（Edit 工具对该文件状态异常时的替代手段）
path = r'D:\下载\minecraft-companion\src\tools\helpers.ts'
newfly_path = r'D:\下载\minecraft-companion\tools\newfly.txt'

raw = open(path, 'rb').read()
crlf = b'\r\n' in raw
nl = '\r\n' if crlf else '\n'
text = raw.decode('utf-8')

newfly = open(newfly_path, 'r', encoding='utf-8').read()
newfly = newfly.replace('\r\n', '\n').replace('\n', nl).rstrip(nl)

start_marker = 'export async function creativeFlyTo('
end_marker = '/** 从背包查找物品 */'
si = text.index(start_marker)
ei = text.index(end_marker, si)

replacement = newfly + nl + nl
new_text = text[:si] + replacement + text[ei:]
open(path, 'wb').write(new_text.encode('utf-8'))
print('OK crlf=%s si=%d ei=%d newlen=%d' % (crlf, si, ei, len(new_text)))
