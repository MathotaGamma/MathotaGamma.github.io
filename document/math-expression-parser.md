# 数式パーサー

## 目標
* Formula<->Code
* Formula<->Latex
* Code<->Latex

## 手順
1. tokenizer
  字句解析。数式を最小単位(要素)に分解する
2. parser
  構文解析。字句の構造を作成する。
  ここではASTを用いて二分木を作成する。
