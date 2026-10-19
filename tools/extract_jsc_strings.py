#!/usr/bin/env python3
"""提取 V8 code cache (.jsc) 常量池字符串:ASCII + UTF-16LE(含 CJK)。

用法: python3 extract_jsc_strings.py <file.jsc> [more.jsc ...]
输出: <file>.strings.txt(ASCII 段)+ <file>.cjk.txt(中文段,按出现序去重)
"""
import re
import sys


def extract(path):
    data = open(path, 'rb').read()

    ascii_strs = re.findall(rb'[\x20-\x7e]{6,}', data)
    seen = set()
    a_out = []
    for s in ascii_strs:
        t = s.decode()
        if t not in seen:
            seen.add(t)
            a_out.append(t)

    # V8 双字节字符串:ASCII 或 CJK 的 UTF-16LE 连续段(>=4 字符)
    cjk = []
    cur = []
    i = 0
    n = len(data)
    while i + 1 < n:
        lo, hi = data[i], data[i + 1]
        ok = (hi == 0 and 0x20 <= lo < 0x7f) or (0x4e <= hi <= 0x9f)
        if ok:
            cur.append(chr(lo | (hi << 8)))
            i += 2
        else:
            if len(cur) >= 4:
                cjk.append(''.join(cur))
            cur = []
            i += 2
    if len(cur) >= 4:
        cjk.append(''.join(cur))
    def is_real_cjk(t):
        # 伪中文两类:偶对齐(两 ASCII 字节配对,双字节都可打印)、
        # 奇对齐(ASCII 的 UTF-16 高零字节 + 字母,lo==0x00)。
        # 真中文多数字符低字节 >=0x80 —— 串级统计"确真"字符占比 >=25% 才保留。
        if len(t) < 2:
            return False
        real = 0
        for c in t:
            if not ('\u4e00' <= c <= '\u9fff'):
                continue
            lo = ord(c) & 0xff
            if lo != 0x00 and not (0x20 <= lo <= 0x7e):
                real += 1
        cjk_n = sum(1 for c in t if '\u4e00' <= c <= '\u9fff')
        return cjk_n >= 2 and real * 4 >= len(t)

    seen2 = set()
    c_out = []
    for t in cjk:
        t = t.strip()
        if t and t not in seen2 and is_real_cjk(t):
            seen2.add(t)
            c_out.append(t)

    base = path
    open(base + '.strings.txt', 'w', encoding='utf-8').write('\n'.join(a_out))
    open(base + '.cjk.txt', 'w', encoding='utf-8').write('\n'.join(c_out))
    print(f'{path}: {len(a_out)} ascii strings -> {base}.strings.txt')
    print(f'{path}: {len(c_out)} cjk strings   -> {base}.cjk.txt')


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    for p in sys.argv[1:]:
        try:
            extract(p)
        except OSError as e:
            print(f'{p}: {e}')
