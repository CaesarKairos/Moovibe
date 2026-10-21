# Migracao xAI/Grok - historico

Este procedimento foi substituido pela [migracao definitiva para GroqCloud](GROQ-MIGRATION.md).
Nao aplicar as instrucoes antigas de ativacao xAI ou rollback de geracao Gemini.

O secret XAI_API_KEY foi preservado por compatibilidade de configuracao, mas
agora deve conter a credencial GroqCloud. O cliente xAI isolado e os registros
historicos de enriquecimento e consumo foram mantidos; nao sao um fallback.
