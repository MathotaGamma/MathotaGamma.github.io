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
  
  <table>
    <thead>
      <tr>
        <th>字句名</th>
        <th>判定(正規表現)</th>
        <th>関数か</th>
        <th>括弧の自動補完</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <th scope="row">space</th>
        <td>/^\s+/</td>
        <td>false</td>
        <td>null</td>
      </tr>
      <tr>
        <th scope="row">comma</th>
        <td>/^,/</td>
        <td>false</td>
        <td>null</td>
      </tr>
      <tr>
        <th scope="row">parStart</th>
        <td>/^\(/</td>
        <td>false</td>
        <td>null</td>
      </tr>
      <tr>
        <th scope="row">parEnd</th>
        <td>/^\)/</td>
        <td>false</td>
        <td>null</td>
      </tr>
      <tr>
        <th scope="row">add</th>
        <td>/^\+/</td>
        <td>false</td>
        <td>null</td>
      </tr>
      <tr>
        <th scope="row">sub</th>
        <td>/^\-/</td>
        <td>false</td>
        <td>null</td>
      </tr>
      <tr>
        <th scope="row">pro</th>
        <td>/^\*/</td>
        <td>false</td>
        <td>null</td>
      </tr>
      <tr>
        <th scope="row">div</th>
        <td>/^\//</td>
        <td>false</td>
        <td>null</td>
      </tr>
      <tr>
        <th scope="row">pow</th>
        <td>/^\^/</td>
        <td>false</td>
        <td>null</td>
      </tr>
      <tr>
        <td colspan="4">絶対値はわからないので\[\]又はabs()を用いる。</td>
      </tr>
      <tr>
        <th scope="row">absStart</th>
        <td>/^\[/</td>
        <td>false</td>
        <td>null</td>
      </tr>
      <tr>
        <th scope="row">absEnd</th>
        <td>/^\]/</td>
        <td>false</td>
        <td>null</td>
      </tr>
      <tr>
        <th scope="row">csc</th>
        <td>/^(csc|cosec)/</td>
        <td>true</td>
        <td>true</td>
      </tr>
      <tr>
        <th scope="row">sec</th>
        <td>/^sec/</td>
        <td>true</td>
        <td>true</td>
      </tr>
      <tr>
        <th scope="row">cot</th>
        <td>/^cot/</td>
        <td>true</td>
        <td>true</td>
      </tr>
      <tr>
        <th scope="row">arccsc</th>
        <td>/^(arccsc|acsc|arccosec|acosec)/</td>
        <td>true</td>
        <td>true</td>
      </tr>
      <tr>
        <th scope="row">arcsec</th>
        <td>/^(arcsec|asec)/</td>
        <td>true</td>
        <td>true</td>
      </tr>
      <tr>
        <th scope="row">arccot</th>
        <td>/^(arccot|acot)/</td>
        <td>true</td>
        <td>true</td>
      </tr>
      <tr>
        <th scope="row">sin</th>
        <td>/^sin/</td>
        <td>true</td>
        <td>true</td>
      </tr>
      <tr>
        <th scope="row">cos</th>
        <td>/^cos/</td>
        <td>true</td>
        <td>true</td>
      </tr>
      <tr>
        <th scope="row">tan</th>
        <td>/^tan/</td>
        <td>true</td>
        <td>true</td>
      </tr>
      <tr>
        <th scope="row">arcsin</th>
        <td>/^(arcsin|asin)/</td>
        <td>true</td>
        <td>true</td>
      </tr>
      <tr>
        <th scope="row">arccos</th>
        <td>/^(arccos|acos)/</td>
        <td>true</td>
        <td>true</td>
      </tr>
      <tr>
        <th scope="row">arctan2</th>
        <td>/^(acrtan2|atan2)/</td>
        <td>true</td>
        <td>**false**</td>
      </tr>
      <tr>
        <th scope="row">arctan</th>
        <td>/^(arctan|atan)/</td>
        <td>true</td>
        <td>true</td>
      </tr>
      <tr>
        <th scope="row">log10</th>
        <td>/^log10/</td>
        <td>true</td>
        <td>**false**</td>
      </tr>
      <tr>
        <th scope="row">log</th>
        <td>/^log/</td>
        <td>true</td>
        <td>true</td>
      </tr>
      <tr>
        <th scope="row">ln</th>
        <td>/^ln/</td>
        <td>true</td>
        <td>true</td>
      </tr>
      <tr>
        <th scope="row">exp</th>
        <td>/^exp/</td>
        <td>true</td>
        <td>true</td>
      </tr>
      <tr>
        <th scope="row">arg</th>
        <td>/^arg/</td>
        <td>true</td>
        <td>true</td>
      </tr>
      <tr>
        <th scope="row">max</th>
        <td>/^max/</td>
        <td>true</td>
        <td>**false**</td>
      </tr>
      <tr>
        <th scope="row">min</th>
        <td>/^min/</td>
        <td>true</td>
        <td>**false**</td>
      </tr>
      <tr>
        <th scope="row">e</th>
        <td>/^e(?!_)/</td>
        <td>false</td>
        <td>null</td>
      </tr>
      <tr>
        <th scope="row">i</th>
        <td>/^i(?!_)/</td>
        <td>false</td>
        <td>null</td>
      </tr>
      <tr>
        <th scope="row">pi</th>
        <td>/^pi|π/</td>
        <td>false</td>
        <td>null</td>
      </tr>
      <tr>
        <th scope="row">num</th>
        <td>^${this.numReg} (変数展開)</td>
        <td>false</td>
        <td>null</td>
      </tr>
      <tr>
        <th scope="row">value</th>
        <td>^(?:${this.character}... (変数展開)</td>
        <td>false</td>
        <td>null</td>
      </tr>
    </tbody>
  </table>
  
  
    
</details>
