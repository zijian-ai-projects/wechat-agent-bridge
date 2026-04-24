# wechat-agent-bridge

> Conecta un chat privado personal de WeChat con un daemon local de coding agent, para controlar Codex local desde WeChat y exponer el mismo bridge mediante MCP.

Other Languages:
[中文](README.md) · [English](README_EN.md) · [日本語](README_JA.md) · [한국어](README_KO.md)

wechat-agent-bridge es un bridge local personal. Escucha mensajes privados de una cuenta de WeChat vinculada, envía los mensajes normales a un coding agent local y devuelve el progreso y el resultado final a WeChat.

Ahora también soporta sesiones multi‑proyecto basadas en `projectsRoot`. Puedes colocar repos locales como `wechat-agent-bridge` y `SageTalk` bajo una misma carpeta raíz de proyectos y mantener por separado el session, history, mode y model de Codex para cada proyecto.

No es un bot público ni un servicio compartido para equipos. v1 usa Codex CLI como backend por defecto y sirve solo a un usuario de WeChat vinculado junto con el estado de sesión local de Codex del usuario actual del sistema operativo.

## Inicio Rápido

```bash
cd /path/to/wechat-agent-bridge
npm install
npm run setup
npm run start
```

`setup` comprueba el login de Codex, vincula WeChat y pide la carpeta raíz de proyectos junto con el proyecto por defecto.

Si el callback del navegador no es cómodo, ejecuta primero:

```bash
codex login --device-auth
```

## Uso Diario en WeChat

```text
/project
/project SageTalk
@SageTalk run tests and summarize failures
```

Los mensajes normales sin `@NombreDelProyecto` van al proyecto actual.

Consulta [docs/commands.md](docs/commands.md) para la referencia completa de comandos.

## Reglas del Directorio de Proyectos

- Solo se tratan como proyectos los subdirectorios de primer nivel bajo `projectsRoot`
- Si colocas un repo nuevo dentro de esa carpeta, aparecerá en `/project`
- Un directorio que no sea Git debe inicializarse explícitamente con `/project <name> --init`
- Al arrancar, el bridge intenta restaurar el último proyecto activo; en el primer setup se elige un proyecto por defecto

## Daemon en Segundo Plano

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

La configuración, la cuenta, las sesiones, el runtime state y los sync buffers se escriben con permisos `0600`. Los logs se redactan y no deben contener tokens, cookies, cabeceras Authorization ni contenido de archivos auth de Codex.

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
  "projectsRoot": "/Users/you/.codex/projects",
  "defaultProject": "wechat-agent-bridge",
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
- `setup` y `start` comprueban Codex, el login de Codex y el `projectsRoot` configurado.
- `/cwd` es un comando de compatibilidad y solo puede cambiar a directorios de proyecto ya configurados.
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

El MCP server reutiliza los mismos core services. No duplica lógica de negocio ni evita las reglas de proyecto o session.

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
