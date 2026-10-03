import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AccountService, accountHandler } from "../../src/accounts/service.js";
import type { CredentialVault } from "../../desktop/credential-vault.js";
import { AccountClient, accountUrl } from "../../desktop/account-client.js";

const services:AccountService[]=[],servers:Server[]=[],roots:string[]=[];
afterEach(async()=>{for(const s of servers.splice(0))await new Promise<void>(r=>s.close(()=>r()));for(const s of services.splice(0))s.close();for(const p of roots.splice(0))await fs.rm(p,{recursive:true,force:true});});
function fixture(file=":memory:") {
  let code="", time=Date.now();
  const service=new AccountService(file,"test-secret-".repeat(4),{async send(_email,value){code=value;}},()=>time);services.push(service);
  return {service,code:()=>code,advance:(ms:number)=>{time+=ms;}};
}
describe("email account boundary",()=>{
  it("creates only after verification, persists a session, consumes codes and revokes logout",async()=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),"ally-account-"));roots.push(root);
    const {service,code}=fixture(path.join(root,"accounts.sqlite"));
    await service.requestCode("User@example.com","one");
    const result=service.verify({email:"user@example.com",code:code()},"one");
    expect(result.profile.email).toBe("user@example.com");
    expect(service.profile(result.token).id).toBe(result.profile.id);
    expect(()=>service.verify({email:"user@example.com",code:code()},"one")).toThrow();
    const reopened=new AccountService(path.join(root,"accounts.sqlite"),"test-secret-".repeat(4),{async send(){}});services.push(reopened);
    expect(reopened.profile(result.token).id).toBe(result.profile.id);
    reopened.logout(result.token);expect(()=>service.profile(result.token)).toThrow(/过期/);
  });
  it("blocks guessing and expired codes",async()=>{
    const f=fixture();await f.service.requestCode("a@example.com","one");
    const wrong=f.code()==="000000"?"000001":"000000";
    for(let n=0;n<5;n++)expect(()=>f.service.verify({email:"a@example.com",code:wrong},"one")).toThrow();
    expect(()=>f.service.verify({email:"a@example.com",code:f.code()},"one")).toThrow(/无效/);
    f.advance(61000);await f.service.requestCode("a@example.com","one");f.advance(600001);
    expect(()=>f.service.verify({email:"a@example.com",code:f.code()},"one")).toThrow(/过期/);
  });
  it("limits resends, expires sessions and removes all sessions on account deletion",async()=>{
    const f=fixture();await f.service.requestCode("a@example.com","one");
    await expect(f.service.requestCode("a@example.com","one")).rejects.toThrow(/60/);
    const first=f.service.verify({email:"a@example.com",code:f.code()},"one");
    f.advance(61000);await f.service.requestCode("a@example.com","one");const second=f.service.verify({email:"a@example.com",code:f.code()},"one");
    expect(second.profile.id).toBe(first.profile.id);
    f.service.deleteAccount(second.token);expect(()=>f.service.profile(first.token)).toThrow();
    await f.service.requestCode("a@example.com","one");const third=f.service.verify({email:"a@example.com",code:f.code()},"one");
    f.advance(31*86400000);expect(()=>f.service.profile(third.token)).toThrow();
  });
  it("does not claim delivery when the mail provider fails",async()=>{
    const service=new AccountService(":memory:","s".repeat(32),{async send(){throw new Error("private provider detail");}});services.push(service);
    await expect(service.requestCode("a@example.com","one")).rejects.toThrow(/发送失败/);
  });
  it("validates endpoint origin and forbids HTTP credentials or redirect paths",()=>{
    expect(accountUrl("https://accounts.example.com")).toBe("https://accounts.example.com");
    expect(accountUrl("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
    for(const url of ["http://example.com","https://user:pass@example.com","https://example.com/other","https://example.com/?token=secret"])expect(()=>accountUrl(url)).toThrow();
  });
  it("exercises HTTP registration and refuses browser origins and unauthenticated profiles",async()=>{
    const f=fixture(), server=createServer(accountHandler(f.service));servers.push(server);
    await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
    const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
    const post=(route:string,body:unknown)=>fetch(base+route,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
    expect((await fetch(base+"/v1/me")).status).toBe(401);
    expect((await fetch(base+"/health",{headers:{Origin:"https://other.invalid"}})).status).toBe(403);
    expect((await post("/v1/code",{email:"a@example.com"})).status).toBe(200);
    const result=await (await post("/v1/verify",{email:"a@example.com",code:f.code()})).json() as {token:string};
    expect((await fetch(base+"/v1/me",{headers:{Authorization:`Bearer ${result.token}`}})).status).toBe(200);
    expect((await post("/v1/verify",{email:"a@example.com",code:f.code()})).status).toBe(400);
  });
  for(const trusted of [false,true]) it(`uses only explicitly trusted proxy identity: ${trusted}`,async()=>{
    const f=fixture();const seen:string[]=[];
    vi.spyOn(f.service,"requestCode").mockImplementation(async(_email,ip)=>{seen.push(ip);return {expiresIn:600,retryAfter:60};});
    const server=createServer(accountHandler(f.service,trusted));servers.push(server);
    await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
    const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
    const response=await fetch(base+"/v1/code",{method:"POST",headers:{"Content-Type":"application/json","X-AllyCode-Client-IP":"198.51.100.2"},body:JSON.stringify({email:"a@example.com"})});
    expect(response.status).toBe(200);expect(seen[0]).toBe(trusted?"198.51.100.2":"127.0.0.1");
  });

  it("keeps local app startup available with a misconfigured account endpoint",async()=>{
    const client=new AccountClient({} as CredentialVault,"http://accounts.example.com");
    expect(await client.state()).toMatchObject({configured:false,message:expect.stringContaining("配置无效")});
  });

});
