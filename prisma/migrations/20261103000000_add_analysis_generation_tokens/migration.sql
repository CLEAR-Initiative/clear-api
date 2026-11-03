-- Provider-reported token usage of the LLM analysis generation (input/output
-- counts, summed across the component calls). USD cost is derived downstream
-- where current prices are known — no volatile price is frozen on the row
-- (the native-Anthropic generation returns tokens, not cost). Null for
-- deterministic-only runs or when the provider reported no usage.
-- See the `analysis` model in prisma/schema.prisma.
ALTER TABLE "analyses" ADD COLUMN "generation_input_tokens" INTEGER;
ALTER TABLE "analyses" ADD COLUMN "generation_output_tokens" INTEGER;
