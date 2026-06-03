# 物理エンジン実装ガイド

> 対象形状: Sphere / Capsule / Box / Plane / Polyhedron  
> コライダー形状: Sphere / Box / Polyhedron  
> ブロードフェーズ: AABB + 球  
> ナローフェーズ: GJK (+EPA)  
> 拘束ソルバー: PGS (Projected Gauss-Seidel)  
> めり込み解決: 逐次位置修正 (Baumgarte / Position Correction)

---

## 目次

1. [基礎数学](#1-基礎数学)
2. [形状の定義と内部表現](#2-形状の定義と内部表現)
3. [剛体 (Rigid Body) の状態管理](#3-剛体-rigid-body-の状態管理)
4. [運動の積分 (Integration)](#4-運動の積分-integration)
5. [ブロードフェーズ衝突検出](#5-ブロードフェーズ衝突検出)
6. [ナローフェーズ衝突検出 — GJK と EPA](#6-ナローフェーズ衝突検出--gjk-と-epa)
7. [衝突情報 (Contact Manifold)](#7-衝突情報-contact-manifold)
8. [衝突応答 — インパルスベース](#8-衝突応答--インパルスベース)
9. [拘束条件 (Constraints)](#9-拘束条件-constraints)
10. [めり込み解決 (Penetration Resolution)](#10-めり込み解決-penetration-resolution)
11. [メインループの組み立て](#11-メインループの組み立て)
12. [補足: 追加形状・最適化](#12-補足-追加形状最適化)

---

## 1. 基礎数学

物理エンジンで頻繁に使う数学ツールをまず整理する。

### 1.1 ベクトル演算

| 演算 | 式 | 用途 |
|------|----|------|
| 加算 | `a + b = (ax+bx, ay+by, az+bz)` | 位置更新、力の合成 |
| スカラー積 | `s * a = (s·ax, s·ay, s·az)` | 速度スケーリング |
| 内積 (dot) | `a · b = ax·bx + ay·by + az·bz` | 投影、角度計算 |
| 外積 (cross) | `a × b = (ay·bz−az·by, az·bx−ax·bz, ax·by−ay·bx)` | 回転軸、法線計算 |
| 長さ | `|a| = sqrt(a · a)` | 距離、正規化 |
| 正規化 | `â = a / |a|` | 方向ベクトル取得 |

**例:**  
`a = (1, 2, 3)`, `b = (4, 0, -1)` のとき  
`a · b = 1·4 + 2·0 + 3·(-1) = 1`  
`a × b = (2·(-1)−3·0, 3·4−1·(-1), 1·0−2·4) = (-2, 13, -8)`

### 1.2 クォータニオン (Quaternion)

回転を表すのに使う。オイラー角は「ジンバルロック」が起きるため使わない。

```
q = (w, x, y, z)   ← w: スカラー部, (x,y,z): ベクトル部
```

**単位クォータニオン (恒等回転):**
```
q_identity = (1, 0, 0, 0)
```

**軸 n̂ まわりに θ 回転するクォータニオン:**
```
q = (cos(θ/2),  sin(θ/2)·nx,  sin(θ/2)·ny,  sin(θ/2)·nz)
```

**例:** Y軸まわりに90° 回転  
```
n̂ = (0,1,0),  θ = π/2
q = (cos(π/4), 0, sin(π/4), 0) ≈ (0.7071, 0, 0.7071, 0)
```

**クォータニオン積 (合成回転):**
```
p * q = (
  pw·qw − px·qx − py·qy − pz·qz,
  pw·qx + px·qw + py·qz − pz·qy,
  pw·qy − px·qz + py·qw + pz·qx,
  pw·qz + px·qy − py·qx + pz·qw
)
```
※ 順序が重要: `p * q ≠ q * p`

**ベクトルの回転:**  
ベクトル `v` をクォータニオン `q` で回転 →  
```
v' = q * (0, vx, vy, vz) * q⁻¹   (クォータニオンの積として計算)
```
実装では回転行列に変換して乗算するほうが速い。

**クォータニオン → 3×3回転行列:**
```
R = [
  1−2(y²+z²),   2(xy−wz),    2(xz+wy)
  2(xy+wz),    1−2(x²+z²),   2(yz−wx)
  2(xz−wy),     2(yz+wx),   1−2(x²+y²)
]
```

**正規化 (数値誤差が蓄積するので毎フレーム行う):**
```
|q| = sqrt(w²+x²+y²+z²)
q_norm = q / |q|
```

### 1.3 慣性テンソル (Inertia Tensor)

物体の「回転のしにくさ」を表す 3×3 対称行列 `I`。  
重心まわりの角運動方程式: `τ = I · α` (τ: トルク, α: 角加速度)

**シミュレーション中は逆行列 `I⁻¹` をよく使う:**
```
α = I⁻¹ · τ
```

対称行列なので固有軸 (主軸) が存在し、その軸では対角成分のみ残る。  
実装では物体ローカル座標での対角テンソル `I_local` を持ち、  
ワールド座標への変換を都度行う:
```
I_world = R · I_local · Rᵀ
```

---

## 2. 形状の定義と内部表現

### 2.1 Sphere (球)

**必要な情報:**
- `center` : Vec3 — 中心座標 (ローカル原点からのオフセット)
- `radius` : float — 半径 r

**コライダーとして使う場合の判定に必要なもの:**  
支持関数 (Support Function): 任意方向 d に対して、最も遠い点を返す  
```
support(d) = center + r · normalize(d)
```

**慣性テンソル (質量 m, 半径 r):**
```
I = (2/5) · m · r²  × I₃  (I₃ は 3×3 単位行列)
```
例: m=1kg, r=0.5m → I = 0.1 × I₃ [kg·m²]

---

### 2.2 Capsule (カプセル)

シリンダー + 両端の半球。キャラクターのコライダーとしてよく使う。

**必要な情報:**
- `pointA`, `pointB` : Vec3 — 内部軸の両端点 (ローカル座標)
- `radius` : float — 半径 r

**形状の本質:** 線分 AB からの距離が r 以内の点の集合

**支持関数:**
```
function support(d):
    if dot(d, pointB - pointA) >= 0:
        return pointB + r · normalize(d)
    else:
        return pointA + r · normalize(d)
```

**高さ h = |pointB - pointA|、質量 m の慣性テンソル (軸 = Y軸 の場合):**
```
Ixx = Izz = m · (h²/12 + r²/4)  + (2/5)·m_cap·r²  (近似)
Iyy = m · r² / 2
```
※ 正確には球帽(Hemisphere)の慣性も含めた計算が必要だが上記で十分な精度が出る。

---

### 2.3 Box (直方体)

**必要な情報:**
- `halfExtents` : Vec3 — 各軸方向の半サイズ (例: (1, 0.5, 2) なら 2×1×4 の箱)
- 位置・回転は剛体の Transform から取得

**8頂点 (ローカル座標):**
```
v[i] = (±hx, ±hy, ±hz)   (符号の組み合わせ 8通り)
```

**支持関数:**
```
support(d_local) = (sign(dx)·hx,  sign(dy)·hy,  sign(dz)·hz)
```
※ d はワールド→ローカル変換してから使う

**慣性テンソル (質量 m, halfExtents = (hx,hy,hz)):**
```
Ixx = (1/3) · m · (hy² + hz²)
Iyy = (1/3) · m · (hx² + hz²)
Izz = (1/3) · m · (hx² + hy²)
```
例: m=2kg, halfExtents=(0.5, 1.0, 0.5) → Ixx=(1/3)·2·(1+0.25)=0.833, Iyy=(1/3)·2·(0.5)=0.333, Izz=0.833

---

### 2.4 Plane (平面)

無限平面。床や壁に使う。常に静止物体(質量∞, 動かない)として扱う。

**必要な情報:**
- `normal` : Vec3 (単位ベクトル) — 平面の法線
- `distance` : float — 原点から平面までの符号付き距離

**平面の方程式:**  
`n · x = d` を満たす点 x が平面上にある

**点 p が平面の表側にある条件:**  
`n · p − d > 0`

**点 p から平面への最短距離 (貫通距離):**  
`penetration = d − n · p`  (正なら平面の裏側 = 貫通)

---

### 2.5 Polyhedron (凸多面体)

頂点を追加してコンベックスハル(凸包)を生成する形式。

**必要な情報:**
- `vertices[]` : Vec3[] — 頂点リスト
- `faces[]` : 面ごとの頂点インデックス + 法線
- `edges[]` : エッジリスト (GJKのウォームスタート用)

**凸包生成:** Quickhull アルゴリズムが一般的  
1. 最も離れた2点を選び初期線分を作る
2. その線分から最も遠い点を選び三角形を作る
3. さらにその三角形から最も遠い点を選び四面体を作る (初期形状)
4. 各面から「外側」にある点を見つけ、可視面を削除して新たな面を張る
5. 全点が内部に収まるまで繰り返す

**支持関数 (GJKの心臓部):**
```
function support(d):
    maxDot = -∞
    result = vertices[0]
    for v in vertices:
        dot = dot(v, d)
        if dot > maxDot:
            maxDot = dot
            result = v
    return result
```

**注意:** GJKが扱えるのは**凸形状のみ**。凹形状は複数の凸形状に分解 (凸分解) してから扱う。

**慣性テンソル:** 多面体の場合は数値積分 (テトラヘドロン分解) で求める:
```
メッシュを四面体に分解し、各四面体の慣性テンソルを重心からのオフセットを
含めて合算する (平行軸の定理を適用)。
```

---

### 2.6 その他の主要な形状 (補足)

| 形状 | 特徴 | 用途 |
|------|------|------|
| **Cylinder (円柱)** | 上下の円 + 側面。凸形状。 | 車輪、柱 |
| **Cone (円錐)** | 底面円 + 頂点。凸形状。 | 錐状オブジェクト |
| **Compound (複合)** | 複数のプリミティブを剛体に貼り付け | 複雑な形状 |
| **Heightfield** | 地形用の高さマップ | 大規模地形 |
| **ConvexHull** | Polyhedronと同義。凸包データ | 汎用凸形状 |

---

## 3. 剛体 (Rigid Body) の状態管理

### 3.1 必要な状態量

```
struct RigidBody {
    // --- 位置・姿勢 ---
    position     : Vec3        // 重心のワールド座標
    orientation  : Quaternion  // 向き

    // --- 速度 ---
    linearVel    : Vec3        // 線速度 [m/s]
    angularVel   : Vec3        // 角速度 [rad/s] (回転軸×角速度の大きさ)

    // --- 質量・慣性 ---
    mass         : float       // 質量 [kg]
    invMass      : float       // 1/mass (静止物体は 0)
    inertiaTensor     : Mat3x3 // ローカル慣性テンソル
    invInertiaTensor  : Mat3x3 // その逆行列 (ローカル)

    // --- 力の蓄積バッファ ---
    forceAccum   : Vec3        // このフレームの合力
    torqueAccum  : Vec3        // このフレームの合トルク

    // --- 素材プロパティ ---
    restitution  : float       // 反発係数 0〜1 (0=完全非弾性, 1=完全弾性)
    friction     : float       // 摩擦係数 μ

    // --- スリープ管理 ---
    isAwake      : bool
    sleepTimer   : float       // 静止し続けた時間
}
```

### 3.2 静止物体 (Static Body) の扱い

- `mass = ∞` → `invMass = 0`
- `inertiaTensor = ∞` → `invInertiaTensor = 0` (ゼロ行列)
- 力・インパルスを受けても動かない

**判別:** `invMass == 0` かどうかで判定する。

### 3.3 力の適用

ある点 `p` (ワールド座標) に力 `F` を加えるとき:
```
// 並進力
forceAccum += F

// トルク (力の作用点から重心へのベクトル r = p - position)
r = p - body.position
torqueAccum += cross(r, F)
```

**例:** 重心から (0.5, 0, 0) 離れた点に (0, 10, 0) の力を加えると  
`r = (0.5, 0, 0)`, `F = (0, 10, 0)`  
`torque = cross((0.5,0,0), (0,10,0)) = (0·0−0·10, 0·0.5−0.5·0, 0.5·10−0·0) = (0, 0, 5)` [N·m]

### 3.4 スリープシステム

静止している物体を計算から除外してパフォーマンスを上げる。

```
threshold_linear  = 0.1  [m/s]
threshold_angular = 0.1  [rad/s]
sleep_time_needed = 0.5  [秒]

毎フレーム:
  if |linearVel| < threshold_linear AND |angularVel| < threshold_angular:
      sleepTimer += dt
      if sleepTimer > sleep_time_needed:
          isAwake = false
  else:
      sleepTimer = 0
      isAwake = true
```

---

## 4. 運動の積分 (Integration)

### 4.1 ニュートンの運動方程式

```
F = m · a        →   a = F / m = F · invMass
τ = I · α        →   α = I⁻¹ · τ
```

### 4.2 半陰的オイラー法 (Semi-Implicit Euler / Symplectic Euler)

最もシンプルで安定性が高い。ゲーム物理では標準。

```
// 1. 加速度を求める
a = forceAccum · invMass + gravity   // 重力を加算
α = I_world⁻¹ · torqueAccum

// 2. 速度を更新 (加速度を使って速度を先に更新)
linearVel  += a · dt
angularVel += α · dt

// 3. 減衰 (数値的な安定化。空気抵抗の近似にもなる)
linearVel  *= (1 - linearDamping  · dt)   // 例: linearDamping = 0.01
angularVel *= (1 - angularDamping · dt)   // 例: angularDamping = 0.05

// 4. 位置・姿勢を更新 (更新後の速度を使う)
position += linearVel · dt

// クォータニオンの角速度による更新:
// dq/dt = 0.5 * q * ω_q   (ω_q は角速度の純虚クォータニオン)
ω_q = Quaternion(0, angularVel.x, angularVel.y, angularVel.z)
orientation += 0.5 · (ω_q * orientation) · dt
orientation = normalize(orientation)

// 5. 力のバッファをリセット
forceAccum  = (0,0,0)
torqueAccum = (0,0,0)
```

**例:**  
`mass=1kg`, `gravity=(0,-9.8,0)`, `dt=0.016s`  
初期 `linearVel=(0,0,0)` → 1フレーム後: `linearVel=(0,-0.157,0)` [m/s]

### 4.3 ワールド慣性テンソルの更新

フレームごとに姿勢が変わるので毎フレーム更新が必要:
```
R = quaternionToMatrix(orientation)
I_world_inv = R · I_local_inv · Rᵀ
```

---

## 5. ブロードフェーズ衝突検出

ナローフェーズ(高精度判定)は計算が重い。  
ブロードフェーズで「衝突しそうなペア」に絞り込んでから渡す。

### 5.1 AABB (Axis-Aligned Bounding Box)

座標軸に整列した直方体。回転なし。

**必要な情報:**
- `min` : Vec3 — 各軸の最小座標
- `max` : Vec3 — 各軸の最大座標

**各形状からのAABB生成:**

```
// Sphere (center, radius)
aabb.min = center - Vec3(radius, radius, radius)
aabb.max = center + Vec3(radius, radius, radius)

// Box (halfExtents, position, rotation R)
// 回転した箱のAABBは、各列ベクトルの絶対値を使って計算
e = Vec3(
    |R[0][0]|·hx + |R[0][1]|·hy + |R[0][2]|·hz,
    |R[1][0]|·hx + |R[1][1]|·hy + |R[1][2]|·hz,
    |R[2][0]|·hx + |R[2][1]|·hy + |R[2][2]|·hz
)
aabb.min = position - e
aabb.max = position + e

// Polyhedron
// 全頂点のワールド座標を計算し、min/maxを取る
aabb.min = aabb.max = vertices_world[0]
for v in vertices_world:
    aabb.min = componentMin(aabb.min, v)
    aabb.max = componentMax(aabb.max, v)
```

### 5.2 AABB 同士の重なり判定

```
function overlapsAABB(a, b) → bool:
    return (a.min.x <= b.max.x AND a.max.x >= b.min.x)
       AND (a.min.y <= b.max.y AND a.max.y >= b.min.y)
       AND (a.min.z <= b.max.z AND a.max.z >= b.min.z)
```

1軸でも離れていれば「分離平面が存在する」= 衝突なし。

**例:**  
A: min=(0,0,0) max=(2,2,2)  
B: min=(1,1,1) max=(3,3,3)  
→ X: 0≤3 ∧ 2≥1 ✓, Y: ✓, Z: ✓ → 重なりあり

### 5.3 球の衝突 (ブロードフェーズ補完)

球の外接球(Bounding Sphere)同士の判定はAABBより速い。

```
function overlapsSphere(a_center, a_radius, b_center, b_radius) → bool:
    dist_sq = dot(b_center - a_center, b_center - a_center)
    r_sum = a_radius + b_radius
    return dist_sq <= r_sum * r_sum   // sqrt を避けるため二乗比較
```

### 5.4 ブロードフェーズのデータ構造

| 手法 | 説明 | 向き |
|------|------|------|
| **総当り** | O(n²) 全ペア比較 | 物体数 < 100 |
| **Sort & Sweep (SAP)** | 1軸でソートし重複区間を見つける | 物体数が多い場合 |
| **BVH (Bounding Volume Hierarchy)** | バウンディングボリュームの木構造 | 静的オブジェクトが多い場合 |
| **Grid / Spatial Hash** | 空間を均等分割 | 均一サイズの物体が多い場合 |

---

## 6. ナローフェーズ衝突検出 — GJK と EPA

### 6.1 GJK アルゴリズムの概念

**GJK (Gilbert–Johnson–Keerthi)** は、2つの凸形状が交差しているかを判定するアルゴリズム。

**核心概念: ミンコフスキー差**

2つの形状 A, B のミンコフスキー差:
```
A ⊖ B = { a - b | a ∈ A, b ∈ B }
```

A と B が交差している ⟺ `A ⊖ B` が原点を含む。

**GJKの支持関数:**
```
support_AB(d) = support_A(d) - support_B(-d)
```
これは `A ⊖ B` 上で、方向 d において最も遠い点を返す。

### 6.2 GJK アルゴリズムの手順

```
function GJK(shapeA, shapeB) → (intersecting: bool, simplex: Simplex):

    d = normalize(posB - posA)   // 初期方向: 形状中心を結ぶ方向
    simplex = {}
    
    loop (最大 64回など上限を設ける):
        A = support_AB(d)         // ミンコフスキー差上の新頂点
        
        if dot(A, d) < 0:
            return false          // 原点に到達できない → 交差なし
        
        simplex.add(A)
        
        (d, contains_origin) = nearestSimplexAndDirection(simplex)
        if contains_origin:
            return true           // 原点を含む → 交差あり
```

### 6.3 nearestSimplex (シンプレックスの最近傍処理)

シンプレックスは最大4点(四面体)からなる。  
各ステップで「原点に最も近い部分シンプレックス」を見つけ、次の探索方向を決める。

#### ケース1: 線分 (2点)

点: `B`, `A` (A が最後に追加した点)
```
AB = B - A
AO = origin - A = -A

if dot(AB, AO) > 0:
    // 原点は線分 AB の Voronoi 領域内
    d = cross(cross(AB, AO), AB)   // AB に垂直で AO 方向の成分を持つ方向
    simplex = {A, B}
else:
    // 原点は A 側
    d = AO
    simplex = {A}
```

#### ケース2: 三角形 (3点)

点: `C`, `B`, `A`  
法線: `ABC = cross(AB, AC)`
```
if dot(cross(ABC, AC), AO) > 0:
    // ACの外側
    if dot(AC, AO) > 0:
        simplex = {A, C};  d = cross(cross(AC, AO), AC)
    else:
        → AB の線分ケースへ
else:
    if dot(cross(AB, ABC), AO) > 0:
        → AB の線分ケースへ
    else:
        if dot(ABC, AO) > 0:
            simplex = {A, B, C};  d = ABC
        else:
            simplex = {A, C, B};  d = -ABC   // 三角形を裏返す
```

#### ケース3: 四面体 (4点)

4つの面それぞれについて「原点がその面の外側か」を確認する。  
外側なら該当面の三角形に縮退→ 三角形ケースへ。  
全面の内側なら → 原点を含む (GJK終了、交差確認)。

### 6.4 EPA (Expanding Polytope Algorithm)

GJKが「交差あり」を検出した後、**貫通深度と衝突法線**を求める。

**アイデア:** GJKで得た四面体を出発点に、ミンコフスキー差の表面を少しずつ広げ、原点に最も近い点(= 最小貫通深度)を探す。

```
function EPA(shapeA, shapeB, simplex) → (normal: Vec3, depth: float):

    polytope = 四面体(simplex の4点)
    faces = 各面の (法線, 距離) リスト
    
    loop:
        // 原点に最も近い面を選ぶ
        closestFace = 距離が最小の面
        d = closestFace.normal
        
        // その方向の支持点を取得
        p = support_AB(d)
        
        // 既にポリトープの表面を超えていないか確認
        if dot(p, d) - closestFace.distance < EPA_TOLERANCE (例: 0.001):
            return (d, dot(p, d))   // 収束
        
        // p から可視な面を削除し、新しい面を生成
        expand polytope with p
```

**出力:**
- `normal` : 衝突法線 (A から見て B の方向)
- `depth` : 貫通深度 (めり込みの量)

### 6.5 形状ペアごとの処理方針

| ペア | 手法 |
|------|------|
| Sphere vs Sphere | 解析的 (距離 − 半径の和) |
| Sphere vs Plane | 解析的 (点-平面距離) |
| Box vs Plane | 頂点-平面距離のループ |
| Sphere vs Box | 最近傍点計算 → 距離判定 |
| Any Convex vs Any Convex | GJK + EPA |
| Capsule vs Sphere | 最近傍点計算(線分 vs 点) |
| Capsule vs Capsule | 最近傍線分間距離 |

**解析的判定が使える場合は使う。GJKは汎用だが、計算コストが高い。**

---

## 7. 衝突情報 (Contact Manifold)

### 7.1 衝突情報の構造

```
struct ContactPoint {
    position       : Vec3    // 衝突点のワールド座標
    normal         : Vec3    // 衝突法線 (B→A 方向の単位ベクトル)
    penetration    : float   // 貫通深度 (正の値)
    
    // 拘束ソルバー用のキャッシュ
    normalImpulse  : float   // 蓄積された法線インパルス
    tangentImpulse : Vec2    // 蓄積された接線インパルス (摩擦)
}

struct ContactManifold {
    bodyA, bodyB      : RigidBody*
    contacts          : ContactPoint[]   // 通常 1〜4点
    normal            : Vec3             // 代表法線
}
```

### 7.2 コンタクトマニフォールドの生成

GJK+EPAは1点しか返さないが、安定した接触には複数の接触点が必要。

**クリッピング法 (Sutherland-Hodgman):**
1. EPA で得た接触法線に垂直な「参照面」と「入射面」を特定
2. 入射面の多角形を参照面の各辺でクリッピング
3. 参照面へ投影したクリッピング結果が接触点群

**4点への削減:**  
生成された接触点が多い場合、面積を最大化するように4点を選ぶ。

### 7.3 接触点のウォームスタート

前フレームのインパルス値を再利用して収束を早める:
```
// 前フレームのコンタクトを位置でマッチング
// 一定距離(例: 0.02m)以内の点を「同じ接触点」と見なす
```

---

## 8. 衝突応答 — インパルスベース

### 8.1 相対速度と反発係数

衝突点 p での相対速度 (A に対する B の速度):
```
v_rel = (v_B + cross(ω_B, r_B)) - (v_A + cross(ω_A, r_A))
```
ここで `r_A = p - posA`, `r_B = p - posB` (接触点からの腕)

法線方向の相対速度 (負なら接近中):
```
v_n = dot(v_rel, n)
```

`v_n >= 0` なら離れているので処理不要 (分離条件)。

### 8.2 法線インパルスの計算

反発係数 `e = min(eA, eB)` (材質の小さい方を使うのが一般的)

**インパルスの大きさ j:**
```
j_numerator   = -(1 + e) · v_n
j_denominator = invMassA + invMassB
              + dot(n, cross(I_A_inv · cross(r_A, n), r_A))
              + dot(n, cross(I_B_inv · cross(r_B, n), r_B))

j = j_numerator / j_denominator
```

**物理的意味:**  
- 分子: 反発後に期待する速度変化 (係数 `1+e`)
- 分母: 有効質量の逆数 (大きいほどインパルスが小さくて済む)

**例:**  
`m_A = m_B = 1kg` (球型の場合を簡略化), `e = 0.5`, `v_n = -2 m/s`  
`j = -(1+0.5)·(-2) / (1+1) = 3/2 = 1.5 [kg·m/s]` = 1.5 Ns のインパルス

### 8.3 速度の更新

```
J = j · n   // インパルスベクトル

// 物体 A (インパルスを受ける方向が逆)
v_A  -= J · invMassA
ω_A  -= I_A_inv · cross(r_A, J)

// 物体 B
v_B  += J · invMassB
ω_B  += I_B_inv · cross(r_B, J)
```

### 8.4 摩擦インパルス

接線方向(法線に垂直)の相対速度から摩擦インパルスを計算。

**接線方向の算出:**
```
v_t = v_rel - dot(v_rel, n) · n   // 接線方向の相対速度ベクトル
if |v_t| < ε:
    return   // すべりなし
t = normalize(v_t)   // 接線単位ベクトル
```

**摩擦インパルスの大きさ:**
```
jt_numerator   = -dot(v_rel, t)
jt_denominator = invMassA + invMassB
               + dot(t, cross(I_A_inv · cross(r_A, t), r_A))
               + dot(t, cross(I_B_inv · cross(r_B, t), r_B))

jt_raw = jt_numerator / jt_denominator
```

**クーロン摩擦モデル (円錐クランプ):**
```
μ = sqrt(μ_A · μ_B)   // 幾何平均でも算術平均でも可

// 静止摩擦 vs 動摩擦
if |jt_raw| <= μ · j:
    jt = jt_raw        // 静止摩擦範囲内
else:
    jt = μ · j · sign(jt_raw)   // 動摩擦でクランプ
```

**摩擦インパルスの適用:**
```
Jt = jt · t

v_A  -= Jt · invMassA
ω_A  -= I_A_inv · cross(r_A, Jt)
v_B  += Jt · invMassB
ω_B  += I_B_inv · cross(r_B, Jt)
```

---

## 9. 拘束条件 (Constraints)

### 9.1 拘束の概念

拘束 (Joint / Constraint) は、2つの物体間の相対運動を制限する。  
例: ヒンジジョイントは1軸のみ回転を許可し、他の自由度を拘束する。

**拘束関数:** `C(position, orientation) = 0` を満たし続けるようにインパルスを加える。

**速度レベルの拘束:** `J · v = b`  
`J`: ヤコビアン (拘束の微分), `v`: 速度ベクトル, `b`: バイアス項

### 9.2 PGS ソルバー (Projected Gauss-Seidel)

複数の拘束を逐次的に解くイテレーション法。

```
for iteration in 0..solver_iterations (例: 10回):
    for each constraint c:
        // 1. 拘束違反の速度を計算
        v_rel = J · velocity_state
        
        // 2. 修正インパルス Δλ を計算
        effective_mass = J · M_inv · Jᵀ
        Δλ = -(v_rel + b) / effective_mass
        
        // 3. 累積インパルスをクランプ (射影ステップ)
        λ_old = λ
        λ = clamp(λ + Δλ,  λ_min,  λ_max)
        Δλ = λ - λ_old
        
        // 4. 速度を更新
        velocity_state += M_inv · Jᵀ · Δλ
```

**`λ_min`, `λ_max` の意味:**  
- 接触法線拘束: `λ_min = 0` (押し込むだけ、引っ張らない)
- 摩擦拘束: `λ_min = -μ·λ_n`, `λ_max = μ·λ_n`
- ジョイント: `λ_min = -∞`, `λ_max = +∞`

### 9.3 ジョイントの種類と自由度

| ジョイント | 制限する自由度 | 許可する自由度 | 用途 |
|------------|--------------|--------------|------|
| **BallAndSocket** | 位置 (3軸) | 回転 (3軸) | 肩関節 |
| **Hinge** | 位置 (3軸) + 回転 (2軸) | 回転 (1軸) | ドアの蝶番 |
| **Slider** | 位置 (2軸) + 回転 (3軸) | 位置 (1軸) | ピストン |
| **Fixed** | 位置 (3軸) + 回転 (3軸) | なし | 溶接 |
| **Distance** | 距離を一定に保つ | その他 | ロープ (伸びない) |

### 9.4 ヒンジジョイントのヤコビアン (例)

アンカー点 `r_A` (A上), `r_B` (B上)、ヒンジ軸 `a_A`

**位置拘束 (アンカーポイントを一致させる):**
```
C_pos = posB + R_B·r_B - posA - R_A·r_A = 0   (3成分)

J_pos = [-I,  cross(R_A·r_A),  I, -cross(R_B·r_B)]
```

**回転拘束 (軸に垂直な2方向の回転を禁止):**  
ヒンジ軸 a に直交する2つのベクトル b, c を使い、  
`dot(R_B·a_B_local, b) = 0` と `dot(R_B·a_B_local, c) = 0` を拘束。

### 9.5 Baumgarte スタビライゼーション

速度レベルだけでは位置誤差が蓄積する。バイアス項 `b` でドリフトを補正:
```
b = β/dt · C   (β: Baumgarte 係数, 典型値 0.1〜0.3)
```

大きすぎると振動、小さすぎると誤差蓄積。  
→ 後述のポジションベースの位置修正と組み合わせる場合は小さめ (0.1) に。

---

## 10. めり込み解決 (Penetration Resolution)

### 10.1 問題の背景

インパルスベース拘束は**速度を修正する**が、すでに起きているめり込み(位置誤差)を直接修正しない。  
Baumgarte は収束が遅く、調整が難しい。

### 10.2 逐次位置修正 (Sequential Position Correction / NGS)

速度ループとは**別に**、位置レベルで少しずつ修正する。

```
POSITION_CORRECTION_ITERATIONS = 3〜5
SLOP = 0.005    // 許容する最小貫通深度 (わずかなめり込みは無視)
PERCENT = 0.8   // 1回のステップで修正する割合 (80%)

for iter in 0..POSITION_CORRECTION_ITERATIONS:
    for each contact (A, B, normal, penetration):
        if penetration < SLOP:
            continue
        
        // 修正量
        correction_magnitude = (penetration - SLOP) / (invMassA + invMassB) · PERCENT
        correction = normal · correction_magnitude
        
        // 位置を直接修正 (速度には触れない)
        posA -= correction · invMassA
        posB += correction · invMassB
        
        // 姿勢の修正 (回転も含む場合)
        // 接触点の腕 r_A, r_B を使って四元数を修正
        δθ_A = -I_A_inv · cross(r_A, correction · invMassA)
        δθ_B =  I_B_inv · cross(r_B, correction · invMassB)
        orientationA = normalize(orientationA + 0.5 · Quaternion(0, δθ_A) · orientationA)
        orientationB = normalize(orientationB + 0.5 · Quaternion(0, δθ_B) · orientationB)
```

**SLOP の理由:** めり込みゼロを完全に維持しようとすると振動が起きる。  
少量の「許容めり込み」を設けることで安定する。

### 10.3 PERCENT 値の調整

| PERCENT | 挙動 |
|---------|------|
| 0.2〜0.4 | 修正が緩やか。多くのイテレーションが必要 |
| 0.8 | 標準的な値。バランスが良い |
| 1.0 以上 | オーバーシュートが起きやすい |

### 10.4 SpeculativeContact (予測接触)

高速移動物体が1フレームで貫通するのを防ぐ。

```
// 次フレームでの推定位置で AABB を拡張
swept_aabb.min = min(current_aabb.min, next_aabb.min)
swept_aabb.max = max(current_aabb.max, next_aabb.max)
```

または **CCD (Continuous Collision Detection)** を使い、  
衝突発生時刻 `t ∈ [0,1]` を二分探索で求めて物体をその時刻に巻き戻す。

---

## 11. メインループの組み立て

### 11.1 シミュレーションループの全体フロー

```
function simulateStep(dt):

    // --- Phase 1: 外力の適用 ---
    for each body:
        applyGravity(body)          // 重力を forceAccum に加算
        applyUserForces(body)       // ゲームロジックからの力

    // --- Phase 2: ブロードフェーズ ---
    updateAABBs()
    candidatePairs = broadphase()   // 重なっている AABB ペアのリスト

    // --- Phase 3: ナローフェーズ ---
    manifolds = []
    for (A, B) in candidatePairs:
        result = narrowphase(A, B)  // GJK + EPA または解析的
        if result.intersecting:
            manifolds.append(buildManifold(A, B, result))

    // --- Phase 4: 速度の積分 ---
    for each body:
        integrateVelocities(body, dt)

    // --- Phase 5: 速度拘束ソルバー (PGS) ---
    initializeConstraints(manifolds, dt)
    for iter in 0..VELOCITY_ITERATIONS (例: 10):
        for each manifold:
            solveNormalConstraint(manifold)
            solveFrictionConstraint(manifold)
        for each joint:
            solveJointConstraint(joint, dt)

    // --- Phase 6: 位置の積分 ---
    for each body:
        integratePositions(body, dt)

    // --- Phase 7: 位置修正 ---
    for iter in 0..POSITION_ITERATIONS (例: 3):
        for each manifold:
            positionalCorrection(manifold)

    // --- Phase 8: スリープ更新 ---
    for each body:
        updateSleep(body, dt)
```

### 11.2 固定タイムステップ (Fixed Timestep)

物理シミュレーションはフレームレートに依存しないよう固定タイムステップを使う。

```
const FIXED_DT = 1/60   // 60Hz 固定
accumulator = 0

function gameLoop(frameDeltaTime):
    accumulator += frameDeltaTime
    
    while accumulator >= FIXED_DT:
        simulateStep(FIXED_DT)
        accumulator -= FIXED_DT
    
    // 残り時間の補間率 (描画用)
    alpha = accumulator / FIXED_DT
    interpolateRenderStates(alpha)
```

### 11.3 パラメータ設計の指針

| パラメータ | 推奨値 | 説明 |
|-----------|-------|------|
| `dt` | 1/60 s | 固定タイムステップ |
| `gravity` | (0, -9.8, 0) | 重力加速度 |
| `velocityIterations` | 8〜20 | 多いほど安定、重い |
| `positionIterations` | 3〜8 | 少なくて済む |
| `linearDamping` | 0.01 | 空気抵抗近似 |
| `angularDamping` | 0.05 | 回転の減衰 |
| `restitution` | 0〜0.5 | 多くのゲームでは低め |
| `friction` | 0.3〜0.8 | 材質に応じて |
| `slop` | 0.005 m | 許容めり込み量 |
| `baumgarte` | 0.1〜0.2 | 位置修正と併用なら小さく |
| `sleepThresholdLinear` | 0.05 m/s | スリープ判定 |
| `sleepThresholdAngular` | 0.05 rad/s | スリープ判定 |
| `sleepTime` | 0.5 s | 静止してからスリープまで |

---

## 12. 補足: 追加形状・最適化

### 12.1 凸分解 (Convex Decomposition)

凹形状 (くぼみのある形) は GJK で直接扱えない。  
`HACD` や `V-HACD` (Volumetric HACD) アルゴリズムで凸形状の集合に分解する。

```
concaveShape = loadMesh("spaceship.obj")
parts = VHACD.decompose(concaveShape, maxConvexHulls=16)
for part in parts:
    addCollider(rigidBody, ConvexHullCollider(part))
```

### 12.2 Island システム (接続成分の管理)

相互作用する物体群をグループ (Island) にまとめ、Island 単位でスリープ管理。

```
// 接触グラフを構築
graph = buildContactGraph(manifolds)
islands = connectedComponents(graph)

for island in islands:
    if island.isAllSleeping():
        skip  // 丸ごとスキップ
    else:
        simulate(island)
```

### 12.3 SubStep (サブステップ)

高速物体や剛いジョイントに対し、1フレームを複数の小さいステップに分割。

```
SUB_STEPS = 4
sub_dt = dt / SUB_STEPS

for _ in 0..SUB_STEPS:
    simulateStep(sub_dt)
```

### 12.4 インパルスキャッシュ (Warm Starting)

前フレームのインパルス値を次フレームの初期値として使うことで、  
少ないイテレーションでも収束を早める。

```
// フレーム開始時に前フレームのインパルスを適用
for contact in manifold:
    applyImpulse(bodyA, bodyB, contact.cachedNormalImpulse · n)
    applyImpulse(bodyA, bodyB, contact.cachedTangentImpulse · t)
```

### 12.5 数値安定化テクニック

**ゼロ除算ガード:**
```
if |denominator| < 1e-10:
    impulse = 0
```

**クォータニオンの正規化:** 100フレームに1回でも良いが、毎フレームが安全。

**大きな質量差に注意:** `invMass` の比が 1000:1 を超えると収束が悪化。  
→ Featherstone 法や階層ソルバーで対処。

**アーティキュレーション:** キャラクターの多関節構造には  
Articulated Rigid Body (ARB) / Featherstone Solver が有効。

---

## 付録: 実装順序の推奨

初めて実装する場合は以下の順で進めると詰まりにくい。

```
Week 1:
  ✓ Vec3, Quaternion, Mat3x3 の数学ライブラリ
  ✓ RigidBody の状態管理
  ✓ 重力 + 半陰的オイラー積分
  ✓ Sphere vs Sphere の解析的衝突 + インパルス応答

Week 2:
  ✓ AABB ブロードフェーズ
  ✓ Plane vs Sphere, Box vs Sphere (解析的)
  ✓ 摩擦インパルス
  ✓ 位置修正 (Slop + Percent)

Week 3:
  ✓ GJK の実装 (Sphere, Box, Polyhedron の支持関数)
  ✓ EPA の実装 → 貫通深度・法線
  ✓ コンタクトマニフォールド
  ✓ PGS ソルバー統合

Week 4:
  ✓ スリープシステム
  ✓ Island 管理
  ✓ ヒンジジョイント (拘束ソルバー)
  ✓ Capsule 対応
```

---
