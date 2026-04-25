# Cursor 지원 모델 & 가격표 (Official)

> 출처: https://cursor.com/docs/models-and-pricing (마지막 업데이트: 2026년 기준)

## Anthropic (앤트로픽)

| 모델 | Input ($/M) | Cache Write | Cache Read | Output ($/M) | 비고 |
|------|------------|-------------|------------|--------------|------|
| Claude 4.7 Opus | $5 | $6.25 | $0.5 | $25 | Max Mode 필요, 1M 토큰 지원 |
| Claude 4.6 Opus | $5 | $6.25 | $0.5 | $25 | Max Mode 필요 |
| Claude 4.6 Opus (Fast) | $30 | $37.5 | $3 | $150 | 연구 미리보기 |
| Claude 4.6 Sonnet | $3 | $3.75 | $0.3 | $15 | 200k+ 입력 시 2배 |
| Claude 4.5 Opus | $5 | $6.25 | $0.5 | $25 | Max Mode 필요 |
| Claude 4.5 Sonnet | $3 | $3.75 | $0.3 | $15 | 200k+ 입력 시 2배 |
| Claude 4 Sonnet 1M | $6 | $7.5 | $0.6 | $22.5 | 대형 컨텍스트, 200k+ 시 2배 |
| Claude 4 Sonnet | $3 | $3.75 | $0.3 | $15 | 숨김 기본값 |
| Claude 4.5 Haiku | $1 | $1.25 | $0.1 | $5 | 숨김 기본값 |

---

## OpenAI

| 모델 | Input ($/M) | Cache Write | Cache Read | Output ($/M) | 비고 |
|------|------------|-------------|------------|--------------|------|
| GPT-5.5 | $5 | - | $0.5 | $30 | Max Mode 필요, Long Context 2배 |
| GPT-5.5 (Fast) | 미지원 | - | - | - | Fast 모드 가능 (높은 가격) |
| GPT-5.4 | $2.5 | - | $0.25 | $15 | Max Mode 필요, 90% 캐시 할인, 1M 토큰 |
| GPT-5.4 Mini | $0.75 | - | $0.075 | $4.5 | 90% 캐시 할인 |
| GPT-5.4 Nano | $0.2 | - | $0.02 | $1.25 | 90% 캐시 할인 |
| GPT-5.3 Codex | $1.75 | - | $0.175 | $14 | Max Mode 필요, reasoning effort variant 지원 |
| GPT-5.2 | $1.75 | - | $0.175 | $14 | - |
| GPT-5.2 Codex | $1.75 | - | $0.175 | $14 | - |
| GPT-5.1 Codex Max | $1.25 | - | $0.125 | $10 | - |
| GPT-5.1 Codex Mini | $0.25 | - | $0.025 | $2 | GPT-5.1 대비 4배Rate Limit |
| GPT-5.1 Codex | $1.25 | - | $0.125 | $10 | - |
| GPT-5-Codex | $1.25 | - | $0.125 | $10 | 숨김 기본값 |
| GPT-5 Fast | $2.5 | - | $0.25 | $20 | 숨김 기본값, 2배 가격 |
| GPT-5 | $1.25 | - | $0.125 | $10 | 숨김 기본값, reasoning effort variant: gpt-5-high |

---

## Google

| 모델 | Input ($/M) | Cache Write | Cache Read | Output ($/M) | 비고 |
|------|------------|-------------|------------|--------------|------|
| Gemini 3.1 Pro | $2 | - | $0.2 | $12 | - |
| Gemini 3 Pro Image Preview | $2 | - | $0.2 | $12 | 이미지 출력: $120/1M 토큰 |
| Gemini 3 Pro | $2 | - | $0.2 | $12 | 숨김 기본값 |
| Gemini 3 Flash | $0.5 | - | $0.05 | $3 | 숨김 기본값 |
| Gemini 2.5 Flash | $0.3 | - | $0.03 | $2.5 | 숨김 기본값 |

---

## xAI

| 모델 | Input ($/M) | Cache Write | Cache Read | Output ($/M) | 비고 |
|------|------------|-------------|------------|--------------|------|
| Grok 4.20 | $2 | - | $0.2 | $6 | 200k+ 입력 시 2배 |

---

## Moonshot (Kimi)

| 모델 | Input ($/M) | Cache Write | Cache Read | Output ($/M) | 비고 |
|------|------------|-------------|------------|--------------|------|
| Kimi K2.5 | $0.6 | - | $0.1 | $3 | 숨김 기본값 |

---

## Cursor (자체 모델)

| 모델 | Input ($/M) | Cache Write | Cache Read | Output ($/M) | 비고 |
|------|------------|-------------|------------|--------------|------|
| Composer 2 | $0.5 | - | $0.2 | $2.5 | Auto/Composer 풀 사용 |
| Composer 2 Fast | $1.5 | - | $0.2 | $7.5 | 기본값 |
| Composer 1.5 | $3.5 | - | $0.35 | $17.5 | 숨김 기본값 |
| Composer 1 | $1.25 | - | $0.125 | $10 | 숨김 기본값 |

---

## Auto 라우팅 가격 (고정)

| 토큰 유형 | $/1M |
|-----------|------|
| Input + Cache Write | $1.25 |
| Output | $6.00 |
| Cache Read | $0.25 |

---

## 현재 코드와 공식 문서 차이

### 1. GPT-5.5 가격 불일치
- **현재 코드**: `gpt-5.5` → $3 input / $15 output
- **공식 문서**: $5 input / $30 output (2배 이상 차이)

### 2. 누락된 모델
- **Claude 4.7 Opus** - 코드에 없음
- **Claude 4.6 Sonnet** - 코드에 없음 (4.5 Sonnet만 있음)
- **Claude 4 Sonnet / 4 Sonnet 1M** - 코드에 없음
- **GPT-5.4** - 코드에 없음 (5.4-medium, 5.4-mini, 5.4-nano 없음)
- **GPT-5.3 Codex** - 코드에 없음
- **Kimi K2.5** - 코드에 없음
- **Grok 4.20** - 코드에 없음

### 3. 잘못된 가격
- **gpt-5.4** - 코드 미존재
- **claude-4.5-opus** - 코드에 없음 (4.6-opus-high로 잘못 매칭 가능)

---

## OpenAI API vs Cursor 가격 비교 (GPT-5.5 기준)

### GPT-5.5 1M 토큰당 가격 비교

| 플랫폼 | Input ($/M) | Output ($/M) | 비고 |
|--------|------------|-------------|------|
| **OpenAI API (Standard)** | $5 | $30 | - |
| **OpenAI API (Batch 50%↓)** | $2.5 | $15 | 배치 모델 5割引 |
| **Cursor API Pool** | $5 | $30 | Pro 플랜 $20에 $20 포함 |

### 결론: Cursor Pro ($20) = OpenAI API $20와 동등

Cursor Pro 플랜의 API 풀 $20는 **OpenAI API 직접 사용과 동일 가격**입니다.
단, Cursor는 추가 과금 없이 사용가능한 **Auto + Composer 풀**이 있어서 효율적입니다.

---

## ChatGPT Plus ($20) vs ChatGPT Pro ($200) vs Cursor Pro ($20) 비교

### 구독 구조 비교

| 항목 | ChatGPT Plus | ChatGPT Pro | Cursor Pro |
|------|-------------|-------------|------------|
| **가격** | $20/月 | $200/月 | $20/月 |
| **API 포함** | ❌ | ❌ | ❌ (별도 과금) |
| **메시지 제한** | 160msg/3h | **무제한** | 사용량 기반 |
| **모델** | GPT-5 + Thinking | **모든 모델 + o1 Pro** | 모든 모델 |
| **o1 Pro** | ❌ | ✅ 무제한 | ❌ |
| **Deep Research** | 제한적 | 무제한 | 사용량 기반 |
| **주요 강점** | 일상적인 AI 사용 | 복잡한 추론 작업 | 코딩 특화 |

### Cursor Pro에서 GPT-5.5 사용 시 월간 사용량 (Pro $20 기준)

| 사용 패턴 | 월간 토큰 소모 | $20 API 풀 상태 |
|-----------|---------------|----------------|
| 가벼운 사용 (일 1-2회) | ~500K 토큰 | ✅ 충분 |
| 중간 사용 (매일 사용) | ~2-5M 토큰 | ⚠️ 추가 과금 필요 |
| 무거운 사용 (파워 유저) | 10M+ 토큰 | ❌ $100+ 추가과금 |

###Cursor Pro vs ChatGPT Plus (가격은 같지만 다름)

| 비교 항목 | Cursor Pro | ChatGPT Plus |
|-----------|-----------|-------------|
| **$20으로できること** | Agent 코딩 + 모든 모델 | Chat + 문서 작업 |
| **강점** | 코드 작성, 리팩토링 | 일반 대화, 브레인스토밍 |
| **API 과금** | 모델별 차등 과금 | 미포함 (구독만) |
| **Auto 모델** | $1.25/M input (개별 모델보다 저렴) | 포함 |
| **적합한 유저** | 개발자, 코딩 에이전트 | 창작자, 학생, 일반 |

### 실용적 결론

1. **$20으로 최대한 가치**: Cursor Pro가 ChatGPT Plus보다 코딩에서 우위
2. **ChatGPT Pro ($200)**: o1 Pro 무제한 필요하면 선택, 그 외에는 비효율적
3. **Cursor Pro에서 GPT-5.5**: $20으로 약 0.8M 토큰 (입력 20% + 출력 80% 기준) → 파워코더는 금방 바닥남
4. **저렴한 대안**: Gemini 2.5 Flash ($0.30/M input) → 같은 $20으로 ~45M 토큰 사용 가능