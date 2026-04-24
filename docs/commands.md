# Command Reference

## /help

- 作用：查看命令总览，或某个命令的详细说明
- 语法：`/help`、`/help <command>`
- 是否会切换当前项目：不会
- 是否会中断当前任务：不会
- 示例：`/help`、`/help project`、`/help replace`
- 注意事项：不带参数时显示常用命令总览；带命令名时显示该命令的详细说明

## /project

- 作用：查看项目列表，或切换当前项目
- 语法：`/project`、`/project <name>`、`/project <name> --init`
- 是否会切换当前项目：会
- 是否会中断当前任务：不会
- 示例：`/project`、`/project SageTalk`、`/project scratch --init`
- 注意事项：项目名来自 `projectsRoot` 下的一级子目录名；非 Git 目录需要显式 `--init`

## /status

- 作用：查看当前项目或指定项目的运行状态
- 语法：`/status`、`/status <project>`
- 是否会切换当前项目：不会
- 是否会中断当前任务：不会
- 示例：`/status`、`/status SageTalk`
- 注意事项：不带项目名时，会显示当前项目和整体概览

## /interrupt

- 作用：中断当前或指定项目的运行中任务
- 语法：`/interrupt`、`/interrupt <project>`
- 是否会切换当前项目：不会
- 是否会中断当前任务：会
- 示例：`/interrupt`、`/interrupt SageTalk`
- 注意事项：不带项目名时作用于当前项目

## /replace

- 作用：中断当前或指定项目，并立即执行新的 prompt
- 语法：`/replace <prompt>`、`/replace <project> <prompt>`
- 是否会切换当前项目：不会
- 是否会中断当前任务：会
- 示例：`/replace 重新跑测试`、`/replace SageTalk 重新按这个方案实现`
- 注意事项：不带项目名时作用于当前项目；目标项目未初始化时，需先执行 `/project <name> --init`

## /history

- 作用：查看最近的对话历史
- 语法：`/history`、`/history <n>`、`/history <project> <n>`
- 是否会切换当前项目：不会
- 是否会中断当前任务：不会
- 示例：`/history`、`/history 10`、`/history SageTalk 5`
- 注意事项：`n` 必须是正整数

## /clear

- 作用：清除当前或指定项目的会话
- 语法：`/clear`、`/clear <project>`
- 是否会切换当前项目：不会
- 是否会中断当前任务：不会
- 示例：`/clear`、`/clear SageTalk`
- 注意事项：清除后，下次普通消息会开启新的 Codex 会话

## /mode

- 作用：查看或切换运行模式
- 语法：`/mode`、`/mode <readonly|workspace|yolo>`、`/mode <project> <readonly|workspace|yolo>`
- 是否会切换当前项目：不会
- 是否会中断当前任务：不会
- 示例：`/mode`、`/mode workspace`、`/mode SageTalk readonly`
- 注意事项：默认是 `readonly`；`yolo` 是高风险全权限模式

## /model

- 作用：查看或切换模型
- 语法：`/model`、`/model <name>`、`/model <project> <name>`
- 是否会切换当前项目：不会
- 是否会中断当前任务：不会
- 示例：`/model`、`/model gpt-5.4`、`/model SageTalk gpt-5.4`
- 注意事项：不带参数时显示当前配置

## /cwd

- 作用：按路径查看或切换到已配置项目
- 语法：`/cwd`、`/cwd <path>`
- 是否会切换当前项目：会
- 是否会中断当前任务：不会
- 示例：`/cwd`、`/cwd /Users/you/.codex/projects/SageTalk`
- 注意事项：这是兼容命令；只支持切换到已配置项目的 cwd，不支持任意 `cd`
