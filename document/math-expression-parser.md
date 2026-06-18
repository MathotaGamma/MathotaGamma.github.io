# 数式パーサー

## 目標
* Formula<->Code
* Formula<->Latex
* Code<->Latex

## 手順
1. tokenizer<br>
  字句解析。数式を最小単位(要素)に分解する
2. parser<br>
  構文解析。字句の構造を作成する。<br>
  ここでは再帰下降構文解析(Prattパーサー)を用いてASTを作成する。

## tokenizer
ここでは、字句解析は単純にtokenリストを**順番に**参照していくだけとする。<br>
*※判定する順番は気を付けなければならない。<br>
例えば、'cosec(1)'という文字列に対してcosとcosecを判定する際、<br>
先にcosを判定してしまうと判定が成功してしまい、cosという字句となってしまうため、<br>
はじめにcosecで判別しなければならない。つまり、ある判定文字列A,Bがあり、<br>
Aの始めの文字からBが続いている場合は先にAを判定する。*
|字句名|判定(正規表現)|関数か|括弧の自動補完|
  |:----|:----|:---:|:---:|
  |space|/^\s+/|false|null|
  |comma|/^,/|false|null|
### 字句リストの例
<details><summary>字句リスト</summary>
  
  |字句名|判定(正規表現)|関数か|括弧の自動補完|
  |:----|:----|:---:|:---:|
  |space|/^\s+/|false|null|
  |comma|/^,/|false|null|
  |parStart|/^\(/|false|null|
  |parEnd|/^\)/|false|null|
  |add|/^\+/|false|null|
  |sub|/^\-/|false|null|
  |pro|/^\*/|false|null|
  |div|/^\//|false|null|
  |pow|/^\^/|false|null|
  |絶対値は向きがわからないので\[\]で入力する。|<|<|<|
  |absStart|/^\[/|false|null|
    absEnd:     {re: /^\]/},
    // cosecがcos判定とならないように、cosより前に判定
    csc:   {re: /^(csc|cosec)/, func: true, par: true},
    sec:   {re: /^sec/, func: true, par: true},
    cot:   {re: /^cot/, func: true, par: true},
    arccsc:{re: /^(arccsc|acsc|arccosec|acosec)/, func: true, par: true},
    arcsec:{re: /^(arcsec|asec)/, func: true, par: true},
    arccot:{re: /^(arccot|acot)/, func: true, par: true},
    sin:   {re: /^sin/, func: true, par: true},
    cos:   {re: /^cos/, func: true, par: true},
    tan:   {re: /^tan/, func: true, par: true},
    arcsin:{re: /^(arcsin|asin)/, func: true, par: true},
    arccos:{re: /^(arccos|acos)/, func: true, par: true},
    arctan2: {re: /^(acrtan2|atan2)/, func: true},
    arctan:{re: /^(arctan|atan)/, func: true, par: true},
    log10: {re: /^log10/, func: true, par: true},
    log:   {re: /^log/, func: true, par: true},
    ln:    {re: /^ln/, func: true, par: true},
    exp:   {re: /^exp/, func: true, par: true},
    arg:   {re: /^arg/, func: true, par: true},
    max:   {re: /^max/, func: true},
    min:   {re: /^min/, func: true},
    e:     {re: /^e(?!_)/},
    i:     {re: /^i(?!_)/},
    pi:    {re: /^pi|π/},
    num:   {re: new RegExp(`^${this.numReg}`)},
    value: {re: new RegExp(`^(?:${this.character}(?:(?:0|[1-9][0-9]*)(?!${this.character})|_(?:${this.character}|${this.numReg})*)?)`)},
  }
</details>
