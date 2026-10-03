export function providerHttpErrorHint(status: number): string {
  switch (status) {
    case 401:
      return "API 密钥无效或已失效。请在“模型与 API”中重新检查密钥。";
    case 402:
      return "API 账户余额不足。密钥已经连接到供应商，但供应商拒绝继续计费；请充值或更换有余额的 API Key。";
    case 403:
      return "API 账户没有调用该模型或接口的权限。请检查模型权限、账户地区与供应商控制台。";
    case 404:
      return "供应商不存在该模型或接口。请刷新动态模型列表，并检查模型名称与传输协议。";
    case 429:
      return "API 请求已达到速率或额度限制。请稍后重试，或检查供应商限额。";
    case 503:
    case 529:
      return "模型供应商暂时过载或不可用，请稍后重试。";
    default:
      return "";
  }
}
