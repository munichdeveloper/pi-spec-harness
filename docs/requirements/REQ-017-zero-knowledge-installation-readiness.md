---
id: REQ-017
title: Zero-knowledge installation readiness
status: approved
---

# REQ-017: Zero-knowledge installation readiness

Anwender muessen den Harness installieren und ein Anliegen in natuerlicher
Sprache einreichen koennen, ohne interne Labels, Workflow-Namen oder
Providerdetails zu kennen. Der Harness muss seine Betriebsbereitschaft nach
Installation oder Upgrade automatisch und fail-closed pruefen. Eine bereits
gebundene inhaltliche Freigabe darf nicht erneut verlangt werden.

Fehlende Credentials, unzureichende Caller-Berechtigungen, inaktive oder
falsch gepinnte Workflows und ein nicht deterministischer Issue-Intake muessen
vor dem ersten produktiven Vorgang sichtbar werden. Secret-Werte duerfen weder
gelesen noch protokolliert werden.

