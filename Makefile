# Oasis Cognition — Single-command launcher
# MLX Transcription runs natively (Apple Silicon GPU) via macOS LaunchAgent.
# Everything else runs in Docker.
#
# First-time setup:
#   make install    — install transcription as auto-start system service
#
# Daily usage:
#   make up        — start everything
#   make down      — stop everything
#   make restart   — restart everything
#   make logs      — tail all Docker logs
#   make status    — show service health

LAUNCHD_LABEL := com.oasis.transcription
LAUNCHD_DOMAIN := gui/$(shell id -u)
TRANSCRIPTION_LOG := $(HOME)/Library/Logs/oasis/transcription.log
MOBILE_RELAY_DIR := $(CURDIR)/apps/mobile-relay
MOBILE_RELAY_LOG := $(HOME)/Library/Logs/oasis/mobile-relay.log
MOBILE_RELAY_PID := /tmp/oasis-mobile-relay.pid
DEV_AGENT_LOG := $(HOME)/Library/Logs/oasis/dev-agent.log
DEV_AGENT_PID := /tmp/oasis-dev-agent.pid
UI_PARSER_LOG := $(HOME)/Library/Logs/oasis/ui-parser.log
UI_PARSER_PID := /tmp/oasis-ui-parser.pid
GIPFORMER_LOG := $(HOME)/Library/Logs/oasis/gipformer.log
GIPFORMER_PID := /tmp/oasis-gipformer.pid
DIARIZATION_LOG := $(HOME)/Library/Logs/oasis/diarization.log
DIARIZATION_PID := /tmp/oasis-diarization.pid

.PHONY: up down restart logs status restart-voice install uninstall transcription-ensure \
	mobile-relay-start mobile-relay-stop dev-agent-start dev-agent-stop \
	gipformer-start gipformer-stop diarization-start diarization-stop \
	ui-parser-start ui-parser-stop \
	docker-ensure docker-fix-stale-state

# ── Main commands ─────────────────────────────────────────────────────────────

up: docker-ensure transcription-ensure dev-agent-start ui-parser-start diarization-start gipformer-start mobile-relay-start
	docker compose up -d
	@echo ""
	@$(MAKE) --no-print-directory status
	@echo ""
	@echo "📋  Tailing logs... (Ctrl+C to detach — services keep running)"
	@echo ""
	docker compose logs -f --tail 20

down: mobile-relay-stop dev-agent-stop ui-parser-stop diarization-stop gipformer-stop
	docker compose down
	@echo "✅  All services stopped. Transcription keeps running (system service)."
	@echo "   To also stop transcription: make uninstall"

restart:
	docker compose down
	$(MAKE) up

logs:
	docker compose logs -f --tail 50

status:
	@echo "=== Docker Services ==="
	@docker compose ps --format "table {{.Name}}\t{{.Status}}"
	@echo ""
	@echo "=== Native Services ==="
	@if curl -s http://localhost:8099/health >/dev/null 2>&1; then \
		echo "  transcription-mlx: ✅ healthy"; \
		curl -s http://localhost:8099/health 2>/dev/null; echo ""; \
	else \
		echo "  transcription-mlx: ❌ not responding"; \
		echo "  Run 'make install' to set up auto-start"; \
	fi
	@if curl -s http://localhost:8008/health >/dev/null 2>&1; then \
		echo "  dev-agent:         ✅ healthy"; \
	else \
		echo "  dev-agent:         ❌ not responding"; \
	fi
	@if curl -s http://localhost:8015/health >/dev/null 2>&1; then \
		echo "  mobile-relay:      ✅ healthy"; \
	else \
		echo "  mobile-relay:      ⏸️  not running"; \
	fi
	@if curl -s http://localhost:8011/health >/dev/null 2>&1; then \
		echo "  ui-parser:         ✅ healthy"; \
	else \
		echo "  ui-parser:         ⏸️  not running"; \
	fi
	@if curl -s http://localhost:8098/health >/dev/null 2>&1; then \
		echo "  gipformer:         ✅ healthy"; \
	else \
		echo "  gipformer:         ⏸️  not running"; \
	fi
	@if curl -s http://localhost:8097/health >/dev/null 2>&1; then \
		echo "  diarization:       ✅ healthy"; \
	else \
		echo "  diarization:       ⏸️  not running"; \
	fi

restart-voice:
	docker compose restart livekit voice-agent
	@echo "✅  Voice pipeline restarted."

# ── Mobile Relay (native Node.js) ────────────────────────────────────────────

mobile-relay-start:
	@mkdir -p $(HOME)/Library/Logs/oasis
	@if curl -s http://localhost:8015/health >/dev/null 2>&1; then \
		echo "📱  Mobile Relay: already running"; \
	else \
		echo "📱  Mobile Relay: starting..."; \
		cd $(MOBILE_RELAY_DIR) && \
		nohup bash -c 'export NVM_DIR="$$HOME/.nvm" && [ -s "$$NVM_DIR/nvm.sh" ] && . "$$NVM_DIR/nvm.sh" && npx ts-node src/main.ts' > $(MOBILE_RELAY_LOG) 2>&1 & \
		echo $$! > $(MOBILE_RELAY_PID); \
		sleep 2; \
		if curl -s http://localhost:8015/health >/dev/null 2>&1; then \
			echo "📱  Mobile Relay: ready"; \
		else \
			echo "📱  Mobile Relay: starting (check $(MOBILE_RELAY_LOG))"; \
		fi; \
	fi

mobile-relay-stop:
	@if [ -f $(MOBILE_RELAY_PID) ]; then \
		kill $$(cat $(MOBILE_RELAY_PID)) 2>/dev/null || true; \
		rm -f $(MOBILE_RELAY_PID); \
		echo "📱  Mobile Relay: stopped"; \
	fi

# ── Dev Agent (native Python, full git access) ───────────────────────────────

dev-agent-start:
	@mkdir -p $(HOME)/Library/Logs/oasis
	@if curl -s http://localhost:8008/health >/dev/null 2>&1; then \
		echo "🔧  Dev Agent: already running"; \
	else \
		echo "🔧  Dev Agent: starting..."; \
		nohup bash $(CURDIR)/scripts/start-dev-agent.sh > $(DEV_AGENT_LOG) 2>&1 & \
		echo $$! > $(DEV_AGENT_PID); \
		sleep 2; \
		if curl -s http://localhost:8008/health >/dev/null 2>&1; then \
			echo "🔧  Dev Agent: ready"; \
		else \
			echo "🔧  Dev Agent: starting (check $(DEV_AGENT_LOG))"; \
		fi; \
	fi

dev-agent-stop:
	@if [ -f $(DEV_AGENT_PID) ]; then \
		kill $$(cat $(DEV_AGENT_PID)) 2>/dev/null || true; \
		rm -f $(DEV_AGENT_PID); \
		echo "🔧  Dev Agent: stopped"; \
	fi

# ── UI Parser (native Python, OmniParser V2 + Tesseract OCR) ────────────────

ui-parser-start:
	@mkdir -p $(HOME)/Library/Logs/oasis
	@if curl -s http://localhost:8011/health >/dev/null 2>&1; then \
		echo "🔍  UI Parser: already running"; \
	else \
		echo "🔍  UI Parser: starting (model load takes ~10s first time)..."; \
		nohup bash $(CURDIR)/scripts/start-ui-parser.sh > $(UI_PARSER_LOG) 2>&1 & \
		echo $$! > $(UI_PARSER_PID); \
		sleep 12; \
		if curl -s http://localhost:8011/health >/dev/null 2>&1; then \
			echo "🔍  UI Parser: ready"; \
		else \
			echo "🔍  UI Parser: starting (check $(UI_PARSER_LOG))"; \
		fi; \
	fi

ui-parser-stop:
	@if [ -f $(UI_PARSER_PID) ]; then \
		kill $$(cat $(UI_PARSER_PID)) 2>/dev/null || true; \
		rm -f $(UI_PARSER_PID); \
		echo "🔍  UI Parser: stopped"; \
	fi

# ── GIPFormer Vietnamese ASR (native Python 3.12) ────────────────────────────

gipformer-start:
	@mkdir -p $(HOME)/Library/Logs/oasis
	@if curl -s http://localhost:8098/health >/dev/null 2>&1; then \
		echo "🇻🇳  GIPFormer: already running"; \
	else \
		echo "🇻🇳  GIPFormer: starting..."; \
		nohup bash $(CURDIR)/scripts/start-gipformer.sh > $(GIPFORMER_LOG) 2>&1 & \
		echo $$! > $(GIPFORMER_PID); \
		sleep 3; \
		if curl -s http://localhost:8098/health >/dev/null 2>&1; then \
			echo "🇻🇳  GIPFormer: ready"; \
		else \
			echo "🇻🇳  GIPFormer: starting (check $(GIPFORMER_LOG))"; \
		fi; \
	fi

gipformer-stop:
	@if [ -f $(GIPFORMER_PID) ]; then \
		kill $$(cat $(GIPFORMER_PID)) 2>/dev/null || true; \
		rm -f $(GIPFORMER_PID); \
		echo "🇻🇳  GIPFormer: stopped"; \
	fi

# ── Diarization (native Python, ONNX CPU) ────────────────────────────────────

diarization-start:
	@mkdir -p $(HOME)/Library/Logs/oasis
	@if curl -s http://localhost:8097/health >/dev/null 2>&1; then \
		echo "🎙️  Diarization: already running"; \
	else \
		echo "🎙️  Diarization: starting..."; \
		nohup bash $(CURDIR)/scripts/start-diarization.sh > $(DIARIZATION_LOG) 2>&1 & \
		echo $$! > $(DIARIZATION_PID); \
		sleep 2; \
		if curl -s http://localhost:8097/health >/dev/null 2>&1; then \
			echo "🎙️  Diarization: ready"; \
		else \
			echo "🎙️  Diarization: starting (check $(DIARIZATION_LOG))"; \
		fi; \
	fi

diarization-stop:
	@if [ -f $(DIARIZATION_PID) ]; then \
		kill $$(cat $(DIARIZATION_PID)) 2>/dev/null || true; \
		rm -f $(DIARIZATION_PID); \
		echo "🎙️  Diarization: stopped"; \
	fi

# ── Transcription LaunchAgent (auto-start + auto-recover) ─────────────────────

install:
	@bash scripts/install-transcription-service.sh

uninstall:
	@bash scripts/install-transcription-service.sh --uninstall

# ── Docker auto-recovery ─────────────────────────────────────────────────────

docker-ensure:
	@if docker info >/dev/null 2>&1; then \
		echo "🐳  Docker: running"; \
	else \
		echo "🐳  Docker: not running — starting Docker Desktop..."; \
		open -a Docker; \
		echo "🐳  Docker: waiting for daemon (up to 60s)..."; \
		STARTED=0; \
		for i in $$(seq 1 30); do \
			if docker info >/dev/null 2>&1; then \
				echo "🐳  Docker: ready (after $$(( $$i * 2 ))s)"; \
				STARTED=1; \
				break; \
			fi; \
			sleep 2; \
		done; \
		if [ "$$STARTED" = "0" ]; then \
			echo "🐳  Docker: unresponsive — force-killing and retrying..."; \
			pkill -9 -f "Docker Desktop" 2>/dev/null || true; \
			pkill -9 -f com.docker 2>/dev/null || true; \
			sleep 5; \
			open -a Docker; \
			echo "🐳  Docker: waiting for daemon (retry, up to 90s)..."; \
			for j in $$(seq 1 45); do \
				if docker info >/dev/null 2>&1; then \
					echo "🐳  Docker: ready on retry (after $$(( $$j * 2 ))s)"; \
					STARTED=1; \
					break; \
				fi; \
				sleep 2; \
			done; \
		fi; \
		if [ "$$STARTED" = "0" ]; then \
			echo "🐳  Docker: failed to start after two attempts. Please start Docker Desktop manually."; \
			exit 1; \
		fi; \
	fi
	@$(MAKE) --no-print-directory docker-fix-stale-state

docker-fix-stale-state:
	@# After a Docker crash, PostgreSQL may leave a stale postmaster.pid
	@# which prevents langfuse-db from starting. Detect and clean it up.
	@STALE_PG=$$(docker compose ps langfuse-db --format '{{.State}}' 2>/dev/null); \
	if [ "$$STALE_PG" = "exited" ] || [ "$$STALE_PG" = "dead" ]; then \
		echo "🐳  Detected stale langfuse-db ($$STALE_PG) — cleaning up postmaster.pid..."; \
		docker compose run --rm langfuse-db rm -f /var/lib/postgresql/data/postmaster.pid 2>/dev/null || true; \
		echo "🐳  Stale state cleaned"; \
	fi
	@# Also fix docker-credential-desktop issue if present
	@if [ -f "$(HOME)/.docker/config.json" ]; then \
		if grep -q '"credsStore"' "$(HOME)/.docker/config.json" 2>/dev/null; then \
			if ! command -v docker-credential-desktop >/dev/null 2>&1; then \
				echo "🐳  Fixing docker-credential-desktop issue..."; \
				TMP=$$(mktemp) && \
				python3 -c "import json,sys; c=json.load(open(sys.argv[1])); c.pop('credsStore',None); json.dump(c,open(sys.argv[2],'w'),indent=2)" \
					"$(HOME)/.docker/config.json" "$$TMP" && \
				mv "$$TMP" "$(HOME)/.docker/config.json"; \
				echo "🐳  Removed credsStore from ~/.docker/config.json"; \
			fi; \
		fi; \
	fi

transcription-ensure:
	@if curl -s http://localhost:8099/health >/dev/null 2>&1; then \
		echo "🎙️  Transcription: running"; \
	elif launchctl print $(LAUNCHD_DOMAIN)/$(LAUNCHD_LABEL) >/dev/null 2>&1; then \
		echo "🎙️  Transcription: LaunchAgent installed, waiting for startup..."; \
		for i in 1 2 3 4 5; do \
			sleep 2; \
			if curl -s http://localhost:8099/health >/dev/null 2>&1; then \
				echo "🎙️  Transcription: ready"; \
				break; \
			fi; \
		done; \
	else \
		echo "🎙️  Transcription not installed — installing now..."; \
		bash scripts/install-transcription-service.sh; \
		sleep 3; \
	fi
