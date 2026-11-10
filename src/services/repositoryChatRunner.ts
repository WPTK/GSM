import {
  runEvidenceDrivenRepositoryChatTurn,
  type RepositoryChatTurnInput,
  type RepositoryChatTurnResult,
} from './repositoryChatService';
import { runToolLoopRepositoryChatTurn } from './agentToolLoop';

/**
 * 仓库问答的执行入口：按设置在两个执行循环间分派。独立成模块以保持依赖
 * 单向——repositoryChatService（编排式循环与共享取证底座）与 agentToolLoop
 * （受控工具循环）互不引用。Claude 原生支持 tool use，无需能力探测。
 */
export const runRepositoryChatTurn = async (input: RepositoryChatTurnInput): Promise<RepositoryChatTurnResult> => {
  if (input.enableAgentToolLoop) {
    return await runToolLoopRepositoryChatTurn(input);
  }
  return await runEvidenceDrivenRepositoryChatTurn(input);
};
