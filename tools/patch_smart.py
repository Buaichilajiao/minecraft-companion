# -*- coding: utf-8 -*-
# 精确替换 helpers.ts 中的 smartPlace 函数
path = r'D:\下载\minecraft-companion\src\tools\helpers.ts'
new_path = r'D:\下载\minecraft-companion\tools\newsmart.txt'

raw = open(path, 'rb').read()
crlf = b'\r\n' in raw
nl = '\r\n' if crlf else '\n'
text = raw.decode('utf-8')

newfn = open(new_path, 'r', encoding='utf-8').read()
newfn = newfn.replace('\r\n', '\n').replace('\n', nl).rstrip(nl)

start_marker = 'export async function smartPlace('
end_marker = '/** 简易容器窗口 shape'
si = text.index(start_marker)
ei = text.index(end_marker, si)

replacement = newfn + nl + nl
new_text = text[:si] + replacement + text[ei:]
open(path, 'wb').write(new_text.encode('utf-8'))
print('OK crlf=%s si=%d ei=%d newlen=%d' % (crlf, si, ei, len(new_text)))
