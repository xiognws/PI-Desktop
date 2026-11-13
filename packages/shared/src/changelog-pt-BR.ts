import type { ChangelogEntry } from "./changelog.js";

export const ptBREntries: ChangelogEntry[] = [
  {
    version: "0.21.0",
    date: "2026-11-13",
    highlights: [
      "Projetos, sessões, plugins, modelos e tarefas agendadas convivem em um único aplicativo de desktop.",
      "Escolha o modo agente, planejamento ou meta por sessão; cada chamada de ferramenta passa por uma camada de permissão antes de executar.",
      "Delegue trabalho a cinco subagentes integrados (explorador, revisor de código, executor de testes, corretor e designer de UI), cada um com contexto próprio.",
      "Conecte qualquer endpoint compatível com OpenAI ou um runtime local de modelos e troque de modelo com a sessão em execução.",
      "Estenda o próprio desktop com plugins: comandos, painéis, widgets flutuantes, views do painel de trabalho, ferramentas de agente, temas, servidores MCP e serviços em segundo plano.",
      "Os dados ficam nesta máquina: sessões, logs e credenciais permanecem locais e o aplicativo não envia telemetria.",
      "Revise mudanças no painel de diff, acompanhe comandos em segundo plano e reabra qualquer arquivo tocado pela sessão na lista de artefatos.",
      "Execute tarefas agendadas de agente com o aplicativo aberto e renderize cartões interativos dentro da conversa.",
    ],
  },
];
