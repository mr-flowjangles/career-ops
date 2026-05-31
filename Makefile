SHELL := /bin/bash
.DEFAULT_GOAL := help

DATE := $(shell date +%Y-%m-%d)

##@ Dashboard
.PHONY: up down restart status dashboard

up: ## Start the dashboard server (http://localhost:3030)
	@if pgrep -f dashboard-server.mjs > /dev/null; then \
	  echo "✅ Dashboard already running at http://localhost:3030"; \
	else \
	  nohup node dashboard-server.mjs > /tmp/career-ops-dashboard.log 2>&1 & \
	  sleep 1; \
	  if pgrep -f dashboard-server.mjs > /dev/null; then \
	    echo "🚀 Dashboard started at http://localhost:3030"; \
	  else \
	    echo "❌ Failed to start. Check /tmp/career-ops-dashboard.log"; exit 1; \
	  fi; \
	fi
	@command -v open >/dev/null && open http://localhost:3030 || true

down: ## Stop the dashboard server
	@if pgrep -f dashboard-server.mjs > /dev/null; then \
	  pkill -f dashboard-server.mjs && echo "🛑 Dashboard stopped"; \
	else \
	  echo "Not running"; \
	fi

restart: down up ## Restart the dashboard server

status: ## Show server status
	@if pgrep -f dashboard-server.mjs > /dev/null; then \
	  echo "✅ Running at http://localhost:3030 (PID: $$(pgrep -f dashboard-server.mjs))"; \
	else \
	  echo "🛑 Not running. Start with: make up"; \
	fi

dashboard: ## Regenerate static dashboard HTML (output/dashboard.html)
	@node generate-dashboard.mjs

##@ Resume generation
.PHONY: pdf pdf-ats docx all-resumes

pdf: ## Generate styled generic CV PDF (output/cv-rob-rose-{date}.pdf)
	@node generate-pdf.mjs cv.md output/cv-rob-rose-$(DATE).pdf --format=letter

pdf-ats: ## Generate Greenhouse / ATS-clean CV PDF (output/RobRoseATS.pdf)
	@node generate-pdf.mjs cv.md output/RobRoseATS.pdf --format=letter --ats

docx: ## Generate ATS-clean Word .docx (output/cv-rob-rose-{date}.docx)
	@node generate-docx.mjs cv.md output/cv-rob-rose-$(DATE).docx

all-resumes: pdf pdf-ats docx ## Generate all three resume formats from cv.md

##@ Job pipeline
.PHONY: scan scan-only auto-eval merge verify dedup normalize liveness sync-db db-stats db-rebuild

sync-db: ## Incrementally sync career-ops.db from MD source-of-truth files
	@node sync-db.mjs

db-rebuild: ## Drop and rebuild career-ops.db from scratch
	@node sync-db.mjs --rebuild

db-stats: ## Show career-ops.db row counts and status breakdown
	@node sync-db.mjs --stats

query: ## Run canned queries on career-ops.db (e.g. `make query VIEW=top`)
	@node query.mjs $(VIEW) $(ARGS)

scan: ## Scan portals + auto-evaluate any new URLs (policy: every added job gets evaluated)
	@node scan.mjs
	@node auto-evaluate.mjs

scan-only: ## Scan portals only — skip auto-evaluation (drops URLs into pipeline.md for manual review)
	@node scan.mjs

auto-eval: ## Evaluate all unchecked URLs in data/pipeline.md
	@node auto-evaluate.mjs

merge: ## Merge batch/tracker-additions into data/applications.md
	@node merge-tracker.mjs

verify: ## Verify pipeline integrity (URLs, statuses, links)
	@node verify-pipeline.mjs

dedup: ## Deduplicate applications.md
	@node dedup-tracker.mjs

normalize: ## Normalize statuses in applications.md to canonical values
	@node normalize-statuses.mjs

liveness: ## Check whether tracked job postings are still active
	@node check-liveness.mjs

##@ System
.PHONY: doctor sync-check update update-check rollback clean help

doctor: ## Run system health check
	@node doctor.mjs

sync-check: ## Check that cv.md and outputs are in sync
	@node cv-sync-check.mjs

update-check: ## Check for career-ops updates from upstream
	@node update-system.mjs check

update: ## Apply career-ops upstream update
	@node update-system.mjs apply

rollback: ## Rollback the last career-ops update
	@node update-system.mjs rollback

clean: ## Remove generated tailored CV PDFs (keeps the generic + ATS)
	@find output -name 'RobRose*.pdf' -not -name 'RobRoseATS*.pdf' -delete 2>/dev/null && \
	  echo "🧹 Removed tailored CVs" || echo "Nothing to clean"

help: ## Show this help
	@awk 'BEGIN {FS = ":.*##"; printf "\nCareer-Ops Makefile\n\nUsage:\n  make \033[36m<target>\033[0m\n"} \
	  /^[a-zA-Z_-]+:.*?##/ { printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2 } \
	  /^##@/ { printf "\n\033[1m%s\033[0m\n", substr($$0, 5) }' $(MAKEFILE_LIST)
	@echo ""
