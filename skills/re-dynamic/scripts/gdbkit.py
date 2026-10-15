"""gdbkit.py - gdb python 插桩公共库（re-dynamic）。

用法（gdb 批处理脚本顶部）:
    import sys; sys.path.insert(0, "/root/.dsh/skills/re-dynamic/scripts")
    import gdbkit as gk
    gk.sig_pass()                       # SIGILL/SIGSEGV 放行给 handler（勿 pass SIGTRAP，gdb 自用）
    log = gk.log_open("/path/out.log")
    gk.B("0x414081", "cmp", lambda: log.write("rax=%#x\\n" % gk.reg("rax")))
    gk.runinp("/path/input.txt")

设计动机：一次性 gdb 脚本的 rd/hx/log/断点类样板在每个脚本里重复——
第二个手写 gdb 脚本起必须 import 本库，禁止再抄样板（re-dynamic §2）。
所有函数对失效内存读容错（返回 None），调用方决定怎么处理。
"""
import gdb

# --- 日志 -----------------------------------------------------------------

def log_open(path):
    f = open(path, "w", buffering=1)  # line-buffered：进程被杀也留住已写行
    return f

# --- 内存/寄存器读写 -------------------------------------------------------

def rd(addr, n):
    """读内存，失败返回 None（不抛异常）。"""
    try:
        return gdb.selected_inferior().read_memory(int(addr), int(n)).tobytes()
    except Exception:
        return None

def wr(addr, data):
    """写内存，成功 True。"""
    try:
        gdb.selected_inferior().write_memory(int(addr), bytes(data))
        return True
    except Exception:
        return False

def hx(b):
    return "<err>" if b is None else " ".join("%02x" % x for x in b)

def _uint(addr, n):
    b = rd(addr, n)
    return None if b is None else int.from_bytes(b, "little")

def u8(a):  return _uint(a, 1)
def u16(a): return _uint(a, 2)
def u32(a): return _uint(a, 4)
def u64(a): return _uint(a, 8)

def cstr(addr, maxlen=256):
    b = rd(addr, maxlen)
    if b is None:
        return "<err>"
    return b.split(b"\x00")[0].decode("latin1", "replace")

def reg(name):
    return int(gdb.parse_and_eval("$" + name))

def pcname():
    """本 inferior 的 PC 寄存器名：64 位是 rip，32 位（wine/PE32、i386 ELF）是 eip。
    别硬编码 $rip——32 位下 gdb 抛 'Cannot convert value to long'，脚本当场死。"""
    try:
        reg("rip")
        return "rip"
    except Exception:
        return "eip"

def pc():
    return reg(pcname())

def setreg(name, val):
    gdb.execute("set $%s = %#x" % (name, int(val)), to_string=True)

def regs():
    """当前通用寄存器快照 dict。"""
    out = {}
    for r in ("rax rbx rcx rdx rsi rdi rbp rsp r8 r9 r10 r11 r12 r13 r14 r15 rip eflags".split()):
        try:
            out[r] = reg(r)
        except Exception:
            pass
    return out

# --- ucontext（SA_SIGINFO handler 第 3 参数，x86-64） ----------------------

UCT = {"RDI": 0x68, "RSI": 0x70, "RBP": 0x78, "RBX": 0x80, "RDX": 0x88,
       "RAX": 0x90, "RCX": 0x98, "RSP": 0xA0, "RIP": 0xA8, "EFL": 0xB0,
       "R8": 0x28, "R9": 0x30, "R10": 0x38, "R11": 0x40, "R12": 0x48,
       "R13": 0x50, "R14": 0x58, "R15": 0x60}

def uct(uc, name):
    """读 ucontext 里的保存寄存器：uct($rdx, "RIP")。"""
    return u64(int(uc) + UCT[name.upper()])

def setuct(uc, name, val):
    """改 ucontext 里的保存寄存器（handler 返回后生效）。"""
    return wr(int(uc) + UCT[name.upper()], int(val).to_bytes(8, "little"))

# --- 信号 ------------------------------------------------------------------

def sig_pass(*sigs):
    """让 handler 干活：默认 SIGILL/SIGSEGV nostop noprint pass。
    别把 SIGTRAP 放进 pass 名单——gdb 断点/单步自用 SIGTRAP，pass 给
    inferior 会让进程被自己的断点信号杀死（实测）。需要时显式传入并自担风险。"""
    for s in (sigs or ("SIGILL", "SIGSEGV")):
        gdb.execute("handle %s nostop noprint pass" % s, to_string=True)

def runinp(path):
    """带输入文件运行（替代 `gdb < input` 的 fd 竞态，re-dynamic §4②）。"""
    gdb.execute("run < " + path)

# --- 断点 ------------------------------------------------------------------

class B(gdb.Breakpoint):
    """命中即记录、默认放行的断点。
    B("0x414081", "cmp")                 — 命中打 'HIT cmp rip=...'
    B("0x414081", "cmp", fn=lambda: ...) — fn() 返回值写入 log(None 跳过)
    ignore=N — 前 N 次命中直接放行（read_line 这类重复调用的标准用法）
    stop=True — 命中后真的停下（默认 False：记录并继续）
    """
    def __init__(self, loc, tag="", fn=None, log=None, ignore=0, stop=False):
        super().__init__(loc if str(loc).startswith("*") else "*" + str(loc))
        self.tag, self.fn, self.log, self.stop_at = tag, fn, log, stop
        self.ignore_count = ignore
        self.hits = 0
    def stop(self):
        self.hits += 1
        line = "HIT %s pc=%#x" % (self.tag or self.location, pc())
        if self.fn is not None:
            try:
                extra = self.fn()
                if extra is not None:
                    line += " " + str(extra)
            except Exception as e:
                line += " <fn error: %s>" % e
        if self.log is not None:
            self.log.write(line + "\n")
        else:
            print(line)
        return self.stop_at

class Force(B):
    """命中后写内存/寄存器再放行：Force("0x..", mem={addr: b"\\x00"*16}, regs={"rax": 1})。"""
    def __init__(self, loc, mem=None, regs=None, **kw):
        def _apply():
            for a, d in (mem or {}).items():
                wr(a, d)
            for r, v in (regs or {}).items():
                setreg(r, v)
            return "forced"
        super().__init__(loc, fn=_apply, **kw)

# --- 跟踪 ------------------------------------------------------------------

def trace_pcs(start, stop_at, log, cap=40000):
    """从 start 单步记录 PC 直到 stop_at 或 cap 条。返回命中数。
    用于回答「这段调用到底执行了什么/有多长」——先量长度再决定读不读。"""
    class _E(gdb.Breakpoint):
        def stop(self):
            return True
    _E("*" + str(start) if not str(start).startswith("*") else str(start))
    gdb.execute("continue", to_string=True)
    n = 0
    while n < cap:
        here = pc()
        log.write("%#x\n" % here)
        n += 1
        if here == int(stop_at):
            break
        gdb.execute("stepi", to_string=True)
    return n

def dump_ranges(log, ranges):
    """ranges: [(addr, len, tag), ...] 逐段 hex 落盘。"""
    for a, n, tag in ranges:
        log.write("=== %s @%#x (%d) ===\n" % (tag, a, n))
        log.write(hx(rd(a, n)) + "\n")
