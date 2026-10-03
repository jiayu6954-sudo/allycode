import { useEffect, useState } from "react";
import type { AccountState } from "../../account-client.js";

export function AccountPanel({onClose}:{onClose:()=>void}):JSX.Element {
  const [state,setState]=useState<AccountState>();
  const [email,setEmail]=useState(""); const [code,setCode]=useState("");
  const [sent,setSent]=useState(false); const [busy,setBusy]=useState(false); const [error,setError]=useState("");
  useEffect(()=>{void window.allycode.accountState().then(setState).catch(e=>setError(String(e)));},[]);
  async function perform(action:()=>Promise<void>) {setBusy(true);setError("");try{await action();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}
  return <div className="modal-backdrop account-backdrop"><section className="setup-card" role="dialog" aria-modal="true" aria-labelledby="account-title">
    <header><h2 id="account-title">邮箱注册与登录</h2><button aria-label="关闭账号页面" onClick={onClose}>×</button></header>
    <p>首次验证邮箱后创建账号；已有账号直接登录，无需记密码。</p>
    <p className="setup-note">本地任务和 API 密钥仍保存在这台电脑。登录暂不提供云同步，也不会隔离同一系统用户的本地项目。</p>
    {!state&&!error&&<p>正在检查账号服务…</p>}
    {state&&!state.configured&&<p role="status">邮箱服务尚未上线。你可以继续使用全部本地功能；服务配置完成后即可注册。</p>}
    {state?.message&&<p role="status">{state.message}</p>}
    {state?.configured&&!state.profile&&<form onSubmit={event=>{event.preventDefault();void perform(async()=>{setState(await window.allycode.accountVerify(email,code));setCode("");});}}>
      <label>邮箱地址<input type="email" autoComplete="email" value={email} onChange={e=>{setEmail(e.target.value);setSent(false);setCode("");}} required disabled={busy}/></label>
      <button type="button" disabled={busy||!email.trim()} onClick={()=>void perform(async()=>{await window.allycode.accountSend(email);setSent(true);})}>{busy?"正在处理…":sent?"重新发送验证码":"获取邮箱验证码"}</button>
      {sent&&<p role="status">验证码已发送，10 分钟内有效。重新发送需间隔 60 秒。</p>}
      <label>六位验证码<input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code} onChange={e=>setCode(e.target.value.replace(/\D/g,""))} required disabled={busy}/></label>
      <p className="setup-note">获取验证码会将邮箱发送至 {state.serviceUrl}，并由邮件服务发送验证邮件。</p>
      <button className="primary" disabled={busy||code.length!==6}>验证并注册／登录</button>
    </form>}
    {state?.profile&&<><p role="status">已登录：<strong>{state.profile.email}</strong></p><button disabled={busy} onClick={()=>void perform(async()=>setState(await window.allycode.accountLogout()))}>退出登录</button><button disabled={busy} onClick={()=>{if(window.confirm("注销将删除服务器账号并使所有登录失效；本机项目文件与任务记录保留。确定注销？"))void perform(async()=>setState(await window.allycode.accountDelete()));}}>注销账号</button></>}
    {error&&<p role="alert" className="settings-error">{error}</p>}
    <footer><button onClick={onClose}>返回本地工作区</button></footer>
  </section></div>;
}
