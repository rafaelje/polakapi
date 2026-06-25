## ADDED Requirements

### Requirement: Project activo requerido para abrir /loop
La ventana `/loop` SHALL bloquear el ingreso si no hay un project activo en el workspace. El usuario MUST seleccionar un project antes de iniciar un run nuevo.

#### Scenario: Sin project activo
- **WHEN** el usuario abre `/loop` y `activeProjectId` es `null`
- **THEN** la ventana muestra "elegí un project primero" y deshabilita el input del Paso 1
- **AND** el botón de elegir project lleva al workspace

#### Scenario: Project con path inválido
- **WHEN** el project activo tiene `pathInvalid: true`
- **THEN** `/loop` muestra el error de validación de path y no permite arrancar un run

### Requirement: Chat multi-turno con CLI configurable
El Paso 1 SHALL permitir una conversación multi-turno con uno de los CLIs disponibles (claude, codex, opencode) para refinar el problema del usuario hasta consolidar `01-problem.md`. Cada turno MUST invocarse en modo one-shot (`-p` / `exec` / `run`) serializando la conversación previa en el prompt — no hay sesión persistente del CLI.

#### Scenario: Usuario inicia conversación
- **WHEN** el usuario escribe un problema en el input y presiona "Enviar"
- **THEN** el sistema invoca el CLI seleccionado pasando un system prompt (`problem-intake.md`) + el mensaje del usuario
- **AND** la respuesta del CLI se renderiza como mensaje del asistente en el chat

#### Scenario: Turno siguiente con historia serializada
- **WHEN** el usuario responde al asistente
- **THEN** el sistema invoca el CLI de nuevo pasando toda la conversación previa (turnos 1..N-1) como contexto en el prompt
- **AND** el output del CLI se agrega al chat

#### Scenario: Usuario cambia de CLI mid-conversación
- **WHEN** el usuario selecciona otro CLI desde el chip selector
- **THEN** los próximos turnos usan el nuevo CLI
- **AND** la conversación previa se preserva (la historia es el contrato, no el CLI)

### Requirement: Edición del system prompt de problem-intake
El usuario SHALL poder editar el system prompt `problem-intake.md` desde el setup del Paso 3 (vista unificada). Cambios temporales aplican al run actual; "↓ guardar como default global" persiste a `<app-config>/prompts/problem-intake.md`.

#### Scenario: Edición temporal del prompt
- **WHEN** el usuario edita el prompt del Paso 1 en el editor inline y vuelve al chat sin guardar como global
- **THEN** los próximos turnos usan el prompt editado
- **AND** el global no cambia

### Requirement: Consolidación a 01-problem.md
El Paso 1 SHALL exponer un botón "consolidar" que, al presionarse, invoca al CLI una última vez para producir `01-problem.md` con el resumen del problema acordado. Ese archivo SHALL persistirse en `<project>/.loop/runs/<run-id>/01-problem.md` y desbloquear el Paso 2.

#### Scenario: Consolidación exitosa
- **WHEN** el usuario presiona "consolidar" con al menos un turno de conversación
- **THEN** se invoca el CLI con un prompt de cierre que pide producir un markdown estructurado
- **AND** el output se escribe en `01-problem.md` del run
- **AND** la UI navega al Paso 2

#### Scenario: Consolidación sin conversación
- **WHEN** el usuario presiona "consolidar" sin haber tenido turnos
- **THEN** el botón está deshabilitado y muestra "agregá al menos un mensaje primero"
