---
description: Analyze RuboCop violations with actionable options
agent: general
---

You are analyzing RuboCop output for a Rails project. Your goal is to provide a structured, actionable overview of linting violations with EXACT file paths and line numbers.

Here is the RuboCop output:

!`bin/rubocop $ARGUMENTS`

CRITICAL FORMATTING REQUIREMENTS:
- ALWAYS include exact file paths and line numbers in the format: `file_path:line_number`
- For every violation mentioned, include the specific location
- Use this format consistently throughout your response
- Make paths clickable/navigable in the terminal

Provide your analysis in this EXACT structure:

## 1. Executive Summary
- Total offenses: X files inspected, Y offenses detected
- Breakdown by severity: Z errors, A warnings, B conventions, C refactors
- Overall assessment (1-2 sentences)

## 2. Most Common Violations
List top 5 violation types in this format:
```
1. CopName (X occurrences)
   What: [brief explanation]
   Impact: [why it matters]
   Example locations:
   - file_path:line_number
   - file_path:line_number
```

## 3. Files Requiring Attention
List ALL files with violations, ordered by offense count:
```
file_path:line_count (X offenses)
  - CopName at :line_number
  - CopName at :line_number
  [list ALL violations with line numbers]

file_path:line_count (Y offenses)
  - CopName at :line_number
  [continue for all files]
```

## 4. Actionable Options

**Option A: Auto-fix Safe Violations**
- Auto-correctable: X offenses
- Command: `bin/rubocop -a [specific files if applicable]`
- Files that will be modified:
  - file_path:line_number (Y fixes)

**Option B: Manual Review & Fix High Priority**
Priority files to fix manually:
1. file_path:line_number - [reason]
2. file_path:line_number - [reason]

**Option C: Configure RuboCop**
Suggest cops to disable/configure: [list if applicable]

**Option D: Explain & Fix Specific Violations**
Ready to help fix any specific file:line_number

## 5. Next Steps
What would you like to do?
- Auto-fix with `bin/rubocop -a`?
- Fix specific file (provide file_path:line_number)?
- Explain a specific cop?
- Update RuboCop config?

REMEMBER: Every violation reference MUST include file_path:line_number format.
