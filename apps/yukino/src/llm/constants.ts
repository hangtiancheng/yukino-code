import { GLOBAL_CONFIG_FILENAME } from "@/config/constants.js";
import { YUKINO_DIR_NAME } from "@/storage/constants.js";

export const DISCOVERY_TIMEOUT_MS = 5_000;
export const MAX_MODEL_PAGES = 10;
export const ANTHROPIC_API_VERSION = "2023-06-01";
export const MODEL_DISCOVERY_FAILED_ERROR = "Model discovery failed";

export const MAX_RETRIES = 3;
export const MAX_DELAY_MS = 60_000;
export const BACKOFF_BASE_DELAY_MS = 1000;
export const RATE_LIMIT_BASE_DELAY_MS = 5000;

const GLOBAL_CONFIG_PATH_HINT = `~/${YUKINO_DIR_NAME}/${GLOBAL_CONFIG_FILENAME}`;

export const ANTHROPIC_API_KEY_MISSING_ERROR = `Anthropic API key not found, set ANTHROPIC_API_KEY in ${GLOBAL_CONFIG_PATH_HINT}, or via ANTHROPIC_API_KEY env variable.`;
export const OPENAI_API_KEY_MISSING_ERROR = `OpenAI API key not found, set OPENAI_API_KEY in ${GLOBAL_CONFIG_PATH_HINT}, or via OPENAI_API_KEY env variable.`;
