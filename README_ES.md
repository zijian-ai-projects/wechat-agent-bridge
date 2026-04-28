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

## Instalación y Despliegue

### Requisitos Previos

- Node.js 20 o superior
- npm
- El CLI `codex` instalado localmente, con `codex login` completado por el mismo usuario del sistema operativo que ejecutará el daemon del bridge
- Una cuenta personal de WeChat para vincular
- Un directorio `projectsRoot` con los proyectos locales como subdirectorios de primer nivel

En Windows, si PowerShell puede ejecutar `codex` pero `npm run setup` sigue diciendo que no encuentra el CLI de Codex, primero actualiza al código más reciente con resolución de shims de Windows. Si todavía falla, puedes indicar explícitamente el ejecutable de Codex:

```powershell
codex --version
Get-Command codex
$env:WECHAT_AGENT_BRIDGE_CODEX_BIN = (Get-Command codex).Source
npm run setup
```

### Instalar desde el Código Fuente

```bash
git clone https://github.com/zijian-ai-projects/wechat-agent-bridge.git
cd wechat-agent-bridge
npm install
npm run build
```

Antes del primer uso, inicializa la configuración local y la vinculación de WeChat:

```bash
npm run setup
```

`setup` escribe configuración, cuenta y datos de session en `~/.wechat-agent-bridge`. Estos archivos contienen estado local y datos de cuenta. No los subas a Git ni los compartas con otros usuarios.

### Ejecutar en Primer Plano

```bash
npm run start
```

Es útil para debug o uso temporal. El bridge se detiene cuando se cierra la terminal. Cuando el arranque termina correctamente, abre automáticamente una terminal de sincronización que ejecuta `npm run attach`. Si el sistema bloquea el popup o no aparece una ventana nueva, ejecútala manualmente:

```bash
npm run attach
```

### Desplegar como Daemon en Segundo Plano

```bash
npm run daemon -- start
npm run daemon -- status
npm run daemon -- logs
npm run daemon -- restart
npm run daemon -- stop
```

v1 no instala automáticamente una unidad systemd, un plist de launchd ni un Windows service. Es un daemon de usuario y debe ejecutarse como el mismo usuario del sistema operativo que completó `codex login`. Si lo arrancas desde un process manager externo o un script de login, usa una ruta absoluta:

```bash
npm --prefix /ABSOLUTE/PATH/TO/wechat-agent-bridge run daemon -- start
```

Actualizar un despliegue existente:

```bash
git pull
npm install
npm run build
npm run daemon -- restart
```

Si ejecutas desde un checkout del código fuente, usa preferentemente el script npm para la terminal de sincronización de escritorio:

```bash
npm run attach
npm run attach -- SageTalk
```

Para usar `wechat-agent-bridge attach` directamente, ejecuta una vez desde el repo:

```bash
npm link
```

## Uso Diario en WeChat

```text
/project
/project SageTalk
/model
/model gpt-5.5
/models
@SageTalk run tests and summarize failures
```

Los mensajes normales sin `@NombreDelProyecto` van al proyecto actual.
`/model` muestra el modelo efectivo y su origen para el proyecto actual; `/model <name>` cambia el modelo de ese proyecto; `/models` lee el catálogo local de modelos de Codex.

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

## Terminal de Sincronización de Escritorio

`npm run start` abre automáticamente una terminal de sincronización cuando el daemon en primer plano arranca correctamente. El daemon en segundo plano no abre popups; conéctate manualmente cuando lo necesites:

```bash
npm run attach
npm run attach -- SageTalk
wechat-agent-bridge attach
wechat-agent-bridge attach SageTalk
```

Si arrancas con un nombre de proyecto, primero cambia a ese proyecto. Una vez conectado, también puedes usar `:project <name>` para cambiar de proyecto.

La entrada normal se ejecuta como prompt del proyecto actual. Las líneas que empiezan con `:` son comandos locales de control:

```text
:status
:project SageTalk
:model
:model gpt-5.5
:models
:interrupt
:replace rehacer en esta dirección
```

`:model` sin argumentos muestra el estado del modelo del proyecto actual; `:model <name>` cambia el modelo del proyecto actual.

Las tareas iniciadas desde WeChat aparecen en la terminal attach, y las tareas iniciadas desde la terminal aparecen en WeChat. Ambos lados comparten la misma session, mode, model y turn activo del proyecto.

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
│   ├── commands/
│   ├── config/
│   ├── core/
│   ├── ipc/
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
