# wechat-agent-bridge

> Conecta un chat privado personal de WeChat con un daemon local de coding agent, para controlar Codex local desde WeChat y exponer el mismo bridge mediante MCP.

Other Languages:
[中文](README.md) · [English](README_EN.md) · [日本語](README_JA.md) · [한국어](README_KO.md)

wechat-agent-bridge es un bridge local personal. Escucha mensajes privados de una cuenta de WeChat vinculada, envía los mensajes normales a un coding agent local y devuelve el progreso y el resultado final a WeChat.

Ahora también soporta aliases de proyecto explícitos y sesiones multi‑proyecto. Puedes conectar repos locales como `bridge` y `SageTalk` al mismo bridge de WeChat y mantener por separado el session, history, mode y model de Codex para cada proyecto.

No es un bot público ni un servicio compartido para equipos. v1 usa Codex CLI como backend por defecto y sirve solo a un usuario de WeChat vinculado junto con el estado de sesión local de Codex del usuario actual del sistema operativo.

## Ejemplo

En WeChat:

```text
/status
```

Respuesta posible:

```text
Status: idle
Mode: readonly
Current directory: /Users/you/projects/app
Recent session: no active task
```

Envía una petición normal:

```text
Revisa por qué fallan los tests de este repo y sugiere una corrección.
```

El bridge envía ese mensaje como prompt al Codex CLI local. El progreso de Codex se sincroniza con WeChat según el intervalo configurado, y la respuesta final vuelve al mismo chat privado.

Si quieres enviar solo un mensaje a un proyecto concreto, puedes escribir:

```text
@SageTalk run tests and summarize failures
```

Ese mensaje se enruta solo al proyecto `SageTalk` y no cambia el proyecto activo actual.

## Instalación y Ejecución

### Requisitos

1. Node.js 20+.
2. `codex` CLI instalado localmente.
3. El usuario actual del sistema operativo ha iniciado sesión en Codex CLI.

Inicio de sesión recomendado:

```bash
codex login
```

Si el callback del navegador no es cómodo:

```bash
codex login --device-auth
```

### Primer plano

```bash
cd /path/to/wechat-agent-bridge
npm install
npm run setup
npm run start
```

`setup` comprueba Codex CLI, vincula WeChat mediante código QR y guarda el directorio de trabajo por defecto junto con los repo roots permitidos.

### Daemon en segundo plano

```bash
npm run build
npm run daemon -- start
npm run daemon -- status
npm run daemon -- logs
npm run daemon -- stop
npm run daemon -- restart
```

El daemon sigue siendo un proceso de usuario. Por defecto reutiliza el estado de sesión de Codex del usuario actual. No ejecutes v1 como un servicio compartido de todo el sistema.

## Datos Locales

Directorio de datos por defecto:

```text
~/.wechat-agent-bridge
```

Puedes cambiarlo con `WECHAT_AGENT_BRIDGE_HOME`. La variable antigua `WECHAT_CODEX_BRIDGE_HOME` todavía se acepta como fallback de compatibilidad.

La configuración, la cuenta, las sesiones y los sync buffers se escriben con permisos `0600`. Los logs se redactan y no deben contener tokens, cookies, cabeceras Authorization ni contenido de archivos auth de Codex.

## Slash Commands

Puedes enviarlos en el chat privado de WeChat vinculado:

- `/help`
- `/project [alias]`
- `/interrupt [project]`
- `/replace [project] <prompt>`
- `/clear [project]`
- `/status [project]`
- `/cwd [path]`
- `/model [project] [name]`
- `/mode [project] [readonly|workspace|yolo]`
- `/history [project] [n]`

`/clear` descarta el antiguo Codex session/thread id, de modo que el siguiente mensaje normal empieza una conversación nueva. Si no se usa `/clear`, los mensajes siguientes prefieren `codex exec resume <SESSION_ID>`.

## Sesiones Multi‑Proyecto

`~/.wechat-agent-bridge/config.json` puede definir aliases de proyecto de forma explícita:

```json
{
  "defaultProject": "bridge",
  "projects": {
    "bridge": { "cwd": "/Users/you/.codex/projects/wechat-agent-bridge" },
    "SageTalk": { "cwd": "/Users/you/.codex/projects/SageTalk" }
  },
  "extraWritableRoots": [
    "/Users/you/.codex/projects"
  ],
  "streamIntervalMs": 10000
}
```

En WeChat:

- `/project` muestra la lista de proyectos configurados y el proyecto activo actual.
- `/project SageTalk` cambia el proyecto activo a `SageTalk`.
- `@SageTalk revisa por qué fallan los tests` envía solo ese mensaje a `SageTalk`.
- `/interrupt SageTalk` interrumpe la tarea actual de `SageTalk`.
- `/replace SageTalk vuelve a implementarlo siguiendo este plan` interrumpe y reemplaza la tarea actual de `SageTalk`.

Cada proyecto mantiene su propio Codex session, history, mode y model. Distintos proyectos pueden ejecutarse en paralelo. Los mensajes nuevos para el mismo proyecto se rechazan mientras siga ocupado, salvo que uses explícitamente `/interrupt` o `/replace`.

## Modos de Codex

| Modo | Codex sandbox |
| --- | --- |
| `readonly` | `--sandbox read-only --ask-for-approval never` |
| `workspace` | `--sandbox workspace-write --ask-for-approval never` |
| `yolo` | `--dangerously-bypass-approvals-and-sandbox` |

El modo por defecto es `readonly`. `yolo` solo se activa tras enviar explícitamente `/mode yolo` y devuelve una advertencia de peligro.

Para permitir que `workspace` escriba en directorios hermanos, configura `extraWritableRoots` en `~/.wechat-agent-bridge/config.json`:

```json
{
  "defaultCwd": "/Users/you/projects/wechat-agent-bridge",
  "allowlistRoots": [
    "/Users/you/projects/wechat-agent-bridge"
  ],
  "extraWritableRoots": [
    "/Users/you/projects"
  ],
  "streamIntervalMs": 10000
}
```

Luego reinicia el daemon:

```bash
npm run daemon -- restart
```

## MCP Server

El proyecto también ofrece un MCP server local por stdio. Codex, Claude, Cursor u otro MCP client pueden llamar a los mismos core services mediante una interfaz estable de tools.

Iniciar MCP:

```bash
npm run mcp
```

Para clientes MCP externos, usa una ruta absoluta:

```bash
npm --prefix /ABSOLUTE/PATH/TO/wechat-agent-bridge run mcp
```

Ejemplo para Codex CLI:

```bash
codex mcp add wechat-agent-bridge -- npm --prefix /ABSOLUTE/PATH/TO/wechat-agent-bridge run mcp
```

Tools:

| Tool | Propósito |
| --- | --- |
| `wechat_status` | Lee el usuario vinculado y el estado de la sesión actual. |
| `wechat_bind_status` | Comprueba si una cuenta de WeChat está vinculada. |
| `wechat_history` | Lee el historial local reciente del bridge. |
| `session_clear` | Interrumpe el trabajo actual y limpia session/history/session id. |
| `agent_resume` | Ejecuta un prompt mediante el backend local actual. |
| `agent_interrupt` | Interrumpe el proceso activo del backend local. |
| `agent_set_mode` | Cambia entre `readonly`, `workspace` y `yolo`. |
| `agent_set_cwd` | Cambia cwd a un Git repo root permitido. |

Consulta [docs/mcp.md](docs/mcp.md).

## Soporte de Plataformas

Hoy el proyecto es Codex-first, pero el core ya está organizado para ser agent-ready:

- Codex CLI: el único backend ejecutable en v1.
- Codex MCP / plugin: empaquetado base en `integrations/codex`.
- Claude Code: template MCP y borrador de skill en `integrations/claude`.
- Cursor: template MCP y borrador de rules en `integrations/cursor`.

`ClaudeCodeBackend` y `CursorAgentBackend` son por ahora typed extension points. Los backends reales deberían implementarse solo cuando estén claras las semánticas de ejecución, resume, interrupt y credenciales.

## Límites Actuales

- Solo procesa mensajes privados del usuario de WeChat vinculado.
- Ignora por defecto grupos, desconocidos, usuarios no vinculados y mensajes de bot.
- No ofrece multiusuario, colaboración de equipo, bot público ni hosting remoto.
- El daemon se ejecuta por defecto como el usuario actual del sistema operativo.
- `setup` y `start` comprueban Codex, el login de Codex, el cwd por defecto y los allowlist roots.
- `/cwd` solo puede cambiar a Git repo roots permitidos.
- `--skip-git-repo-check` no se activa por defecto.

Estos son valores seguros de v1, no omisiones temporales.

## Cómo Funciona

```text
Mensaje privado de WeChat
  ↓
WeChatMonitor recoge mensajes
  ↓
BridgeService filtra el usuario y maneja slash commands o prompts normales
  ↓
AgentService llama al AgentBackend actual
  ↓
CodexExecBackend ejecuta codex exec / codex exec resume
  ↓
StreamBuffer sincroniza progreso según el intervalo configurado
  ↓
WeChatSender devuelve el resultado
```

El MCP server reutiliza los mismos core services. No duplica lógica de negocio ni evita las reglas de allowlist o session.

## Estructura del Repositorio

```text
.
├── README.md
├── README_EN.md
├── README_JA.md
├── README_KO.md
├── README_ES.md
├── docs/
├── integrations/
├── src/
│   ├── backend/
│   ├── core/
│   ├── mcp/
│   ├── runtime/
│   ├── setup/
│   └── wechat/
└── tests/
```

## Design Notes

- [docs/design-process.md](docs/design-process.md): notas de evolución del diseño.
- [docs/architecture.md](docs/architecture.md): límites actuales de la arquitectura.
- [docs/mcp.md](docs/mcp.md): MCP server y contrato de tools.
- [docs/integrations.md](docs/integrations.md): estrategia de integración Codex / Claude / Cursor.

## Desarrollo y Verificación

```bash
npm run typecheck
npm test
npm run build
```

## Referencias de Arquitectura

Este proyecto toma como referencia la estructura de protocolo WeChat, session, daemon, chunking y monitor de `wechat-claude-code`, sustituyendo el provider Claude/Anthropic:

- https://github.com/Wechat-ggGitHub/wechat-claude-code
- https://github.com/Wechat-ggGitHub/wechat-claude-code/blob/main/src/main.ts
- https://github.com/Wechat-ggGitHub/wechat-claude-code/blob/main/src/wechat/monitor.ts
- https://github.com/Wechat-ggGitHub/wechat-claude-code/blob/main/scripts/daemon.sh
