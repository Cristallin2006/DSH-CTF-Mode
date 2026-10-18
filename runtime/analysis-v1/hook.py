#!/usr/bin/env python3
"""Analysis hooks: persistence failures are nonblocking but explicitly unhealthy."""
import hashlib
import json
from pathlib import Path
import sys
import time

sys.path.insert(0,str(Path(__file__).resolve().parent))
import session

def digest(value):
    return hashlib.sha256(session.packed(value).encode()).hexdigest()

def startup_context(sid):
    return ('[DSH 分析会话 v1] 按当前问题选择专业 skill，路线、工具和合理重试由模型决定。'
            '恢复旧会话按需重新读取当前专业 skill，旧方法类硬门禁已退役。'
            '时间盒用于盘点证据；工具 advice 是建议。单点查询无需建完整任务。'
            '多阶段、恢复或协作任务使用 analysis-session，关键发现关联证据与目标代次。'
            '候选、测试和外部接受分别说明，可带未决问题合法收尾并记录后台资源。'
            '当前 session_id='+sid+'。受限会话优先用原生 analysis_session 工具管理任务状态，'
            'init 自动绑定本会话；health 检查实际落库与钩子健康。'
            'init options={goal,data:{}}；checkpoint/transition 的内容放 options.data；参数不明用 action=schema。'
            '普通 shell 的 CLI 仍遵守会话沙箱；不要为写状态目录而全局放开权限。'
            '共享写操作用 lease/guard；未登记的旧 daemon 不会自动认领或终止。'
            '完整材料可用 dsh_handoff 分块交接，摘要不代替原文，凭据不写普通记忆。'
            'dsh_control status 显示本会话是否受控；只有宿主导入策略的任务具有请求预算和工具拒绝，普通会话未全局拦网。')

def advice_for(response):
    if not isinstance(response,str):return None
    if 'Could not recover jumptable' in response:
        return '跳转表未恢复：可比较汇编/P-code，或用 ghidra-core 的 jt_resolve.py；限定伪码结论范围。'
    if '"selfmod_signal"' in response and ('"hit": true' in response or '"hit":true' in response):
        return '信号机制线索：检查 handler 对保存 PC 的影响；单独字节命中尚不能证明 handler 存在。'
    if '"python_ext": true' in response or '"python_ext":true' in response:
        return 'CPython 扩展线索：元数据、常量与帧槽位可帮助恢复变量角色；按问题选择静态或动态取证。'
    return None

def run(payload):
    point=str(payload.get('hook_event_name') or '')
    sid=str(payload.get('session_id') or '')
    if not sid:raise ValueError('hook payload has no session_id')
    tool=str(payload.get('tool_name') or '')
    call=str(payload.get('tool_use_id') or '')
    ti=payload.get('tool_input') or {}
    response=payload.get('tool_response')
    now=time.time()
    context=startup_context(sid) if point in ('SessionStart','SubagentStart') else None
    advice=advice_for(response) if point=='PostToolUse' else None
    data={'tool':tool,'call_id':call,'runtime_version':session.VERSION}
    if ti:data['input_sha256']=digest(ti)
    if response is not None:
        data.update(response_sha256=digest(response),response_chars=len(str(response)),returncode=None)
        try:parsed=json.loads(response) if isinstance(response,str) else response
        except (ValueError,TypeError):parsed=None
        if isinstance(parsed,dict):
            for key in ('exit_code','returncode','rc'):
                if isinstance(parsed.get(key),int):data['returncode']=parsed[key];break
    health={'status':'ok','event':point,'state':str(session.STATE),'runtime_version':session.VERSION}
    rc=0
    try:
        with session.database() as con:
            con.execute('INSERT INTO sessions(id,cwd) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET cwd=excluded.cwd',(sid,payload.get('cwd')))
            task=con.execute('SELECT task FROM sessions WHERE id=?',(sid,)).fetchone()[0]
            if point=='PostToolUse' and call:
                pre=con.execute('SELECT ts FROM events WHERE key=?',(sid+':PreToolUse:'+call,)).fetchone()
                if pre:data['elapsed_seconds']=round(now-pre[0],3)
            if point in ('Stop','SubagentStop') and task:
                status=session.inspect_status(con,task)
                data.update(checkpoint=status['task'].get('checkpoint',{}),task_status=status['task']['status'],resources=status['resources'],
                            note='turn end is not task completion; unresolved hypotheses remain available')
            if point=='PostToolUse' and 'skill' in tool.lower() and isinstance(ti,dict):
                candidate=ti.get('name') or ti.get('skill_name') or ti.get('path')
                if candidate:
                    path=Path(str(candidate))
                    if not path.is_absolute():path=session.ROOT/'skills'/str(candidate)/'SKILL.md'
                    try:
                        path=path.resolve(strict=True)
                        if path.is_relative_to((session.ROOT/'skills').resolve()) and path.is_file():
                            data.update(requested_skill=str(path.relative_to(session.ROOT/'skills')),requested_skill_sha256=hashlib.sha256(path.read_bytes()).hexdigest())
                    except OSError:pass
            session.event(con,point,data,sid,task,sid+':'+point+':'+call if call else None)
            if advice:
                reminder=sid+':'+digest(advice)
                signature=digest(response)
                row=con.execute('SELECT signature,ts FROM reminders WHERE key=?',(reminder,)).fetchone()
                if not row or (signature!=row['signature'] and now-row['ts']>=300):
                    context='[分析建议，可按证据选择] '+advice
                    con.execute('INSERT OR REPLACE INTO reminders VALUES(?,?,?)',(reminder,signature,now))
    except Exception as exc:
        rc=1  # CC bridge treats 1 as nonblocking failure; adapter delivers fallback context.
        health.update(status='degraded',error=type(exc).__name__+': '+str(exc))
        warning='[DSH 分析状态故障] 本次事件未能持久化，恢复/检查点记录不可依赖。用 analysis_session(action="health") 检查；不要全局放开沙箱。'
        context='\n'.join(x for x in (context,('[分析建议，可按证据选择] '+advice if advice and not context else None),warning) if x)
        print('analysis persistence degraded: '+health['error'],file=sys.stderr)
    result={'analysisHealth':health}
    if context:result['hookSpecificOutput']={'hookEventName':point,'additionalContext':context}
    return rc,result

def main():
    try:
        rc,result=run(json.load(sys.stdin))
    except Exception as exc:
        rc=1
        result={'analysisHealth':{'status':'degraded','error':type(exc).__name__+': '+str(exc)}}
        print('analysis hook payload failure: '+str(exc),file=sys.stderr)
    print(session.packed(result))
    return rc

if __name__=='__main__':sys.exit(main())
