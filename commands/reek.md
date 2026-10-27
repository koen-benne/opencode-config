---
description: Analyze Reek code smells with actionable options
agent: general
---

You are analyzing Reek output for a Rails project. Your goal is to provide a structured, actionable overview of code smells with EXACT file paths and line numbers.

Here is the Reek output:

!`bin/reek $ARGUMENTS`

CRITICAL FORMATTING REQUIREMENTS:
- ALWAYS include exact file paths and line numbers in the format: `file_path:line_number`
- For every code smell mentioned, include the specific location and method/class name
- Use this format consistently throughout your response
- Make paths clickable/navigable in the terminal

Provide your analysis in this EXACT structure:

## 1. Executive Summary
- Total smells: X files inspected, Y code smells detected
- Most affected files: Z files with smells
- Overall code quality: [1-2 sentence assessment]

## 2. Most Common Code Smells
List top 5 smell types in this format:
```
1. SmellName (X occurrences)
   What: [brief explanation]
   Impact: [maintainability concern]
   Example locations:
   - file_path:line_number (ClassName#method_name)
   - file_path:line_number (ClassName#method_name)
```

## 3. Hotspot Files
List ALL files with smells, ordered by smell count:
```
file_path (X smells)
  - SmellName at :line_number in ClassName#method_name
    [brief context: parameter count, complexity score, etc.]
  - SmellName at :line_number in ClassName#method_name
    [brief context]
  [list ALL smells with specific line numbers and context]

file_path (Y smells)
  - SmellName at :line_number in ClassName#method_name
  [continue for all files]
```

## 4. Critical Smells Requiring Attention
Focus on high-impact smells:
```
1. file_path:line_number - ClassName#method_name
   Smell: [name and severity]
   Refactoring: [specific technique: Extract Method, Extract Class, etc.]
   
2. file_path:line_number - ClassName#method_name
   Smell: [name and severity]
   Refactoring: [specific technique]
```

## 5. Actionable Options

**Option A: Refactor High-Priority Smells**
Priority files to refactor:
1. file_path:line_number - [smell type, suggested refactoring]
2. file_path:line_number - [smell type, suggested refactoring]

**Option B: Incremental Improvement**
Start with one file or smell type:
- Easiest wins: file_path:line_number
- Biggest impact: file_path:line_number

**Option C: Configure Reek**
Suggest detectors to disable/configure: [list if applicable]

**Option D: Deep Dive**
Ready to help refactor any specific file:line_number with detailed guidance

**Option E: Accept & Document**
Smells that may be acceptable trade-offs for this codebase

## 6. Next Steps
What would you like to do?
- Refactor specific file (provide file_path:line_number)?
- Explain a specific smell type in detail?
- Create a phased refactoring plan?
- Update Reek config?

REMEMBER: Every smell reference MUST include file_path:line_number and method/class context.
