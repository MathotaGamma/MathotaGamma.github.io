# 物理エンジン実装ガイド v3

> 対象形状: Sphere / Capsule / Box / Plane / Polyhedron / Cylinder / Cone / Compound  
> コライダー形状: Sphere / Box / Polyhedron (凸形状のみGJK対象)  
> ブロードフェーズ: AABB + Bounding Sphere  
> ナローフェーズ: GJK (+EPA)、解析的判定(特殊ペア)  
> 拘束ソルバー: PGS (Projected Gauss-Seidel)  
> めり込み解決: 逐次位置修正 (Sequential Position Correction)

---

## 目次

1. [基礎数学](#1-基礎数学)
2. [形状の定義と内部表現](#2-形状の定義と内部表現)
3. [剛体の状態管理](#3-剛体の状態管理)
4. [運動の積分](#4-運動の積分)
5. [ブロードフェーズ衝突検出](#5-ブロードフェーズ衝突検出)
6. [ナローフェーズ衝突検出 — GJK と EPA](#6-ナローフェーズ衝突検出--gjk-と-epa)
7. [衝突情報 (Contact Manifold)](#7-衝突情報-contact-manifold)
8. [衝突応答 — インパルスベース](#8-衝突応答--インパルスベース)
9. [拘束条件 (Constraints / Joints)](#9-拘束条件-constraints--joints)
10. [めり込み解決](#10-めり込み解決)
11. [Island システム](#11-island-システム)
12. [CCD (連続衝突検出)](#12-ccd-連続衝突検出)
13. [メインループ](#13-メインループ)
14. [パラメータ設計指針](#14-パラメータ設計指針)

---

## 1. 基礎数学

物理エンジン全体を通して使う数学ツール。後のセクションで「この演算がなぜ必要か」が随時出てくる。

### 1.1 ベクトル演算

ベクトルは位置・速度・力・方向など、方向と大きさを持つ量を表す。  
物理エンジンでは3次元ベクトル `(x, y, z)` を頻繁に使う。

| 演算 | 式 | 何に使うか |
|------|----|-----------|
| 加算 | `a + b = (ax+bx, ay+by, az+bz)` | 位置の更新、複数の力を合算する |
| スカラー倍 | `s · a = (s·ax, s·ay, s·az)` | 速度を時間でスケーリングして移動量を出す |
| 内積 (dot) | `a · b = ax·bx + ay·by + az·bz` | ある方向への投影量を求める。例: 法線方向の速度成分 |
| 外積 (cross) | `a × b = (ay·bz−az·by, az·bx−ax·bz, ax·by−ay·bx)` | 2ベクトルに垂直な方向を求める。例: トルクの計算 |
| 長さ | `\|a\| = sqrt(a · a)` | 2点間の距離、貫通深度の大きさ |
| 正規化 | `â = a / \|a\|` | 「大きさ1の方向ベクトル」に変換。法線など |

**計算例:**  
`a = (1, 2, 3)`, `b = (4, 0, -1)` のとき  
`a · b = 1·4 + 2·0 + 3·(-1) = 1`  
`a × b = (2·(−1)−3·0, 3·4−1·(−1), 1·0−2·4) = (−2, 13, −8)`

---

### 1.2 クォータニオン (Quaternion)

物体の**回転(向き)**を表すために使う。  
オイラー角 (Roll/Pitch/Yaw) はある角度で軸が重なり回転が壊れる「ジンバルロック」が起きるため、3D物理ではクォータニオンが標準。

```
q = (w, x, y, z)
    w : スカラー部  ← cosθ/2 に対応
    x, y, z : ベクトル部  ← 回転軸 × sinθ/2 に対応
```

**単位クォータニオン (回転なし・初期状態):**
```
q_identity = (1, 0, 0, 0)
```

**軸 n̂ = (nx, ny, nz) の周りに角度 θ だけ回転するクォータニオン:**
```
q = ( cos(θ/2),  sin(θ/2)·nx,  sin(θ/2)·ny,  sin(θ/2)·nz )
```
→ n̂ は単位ベクトルでないといけない。`|n̂| = 1` であること。

**計算例:** Y軸まわりに90°回転
```
n̂ = (0, 1, 0),  θ = π/2 (= 90°)
q = ( cos(π/4),  0,  sin(π/4),  0 )
  ≈ ( 0.7071,  0,  0.7071,  0 )
```

**クォータニオン積 (回転の合成):**  
「まず q_A で回転、次に q_B で回転」を1つのクォータニオンで表す操作。順序が重要: `p * q ≠ q * p`。
```
result.w = pw·qw − px·qx − py·qy − pz·qz
result.x = pw·qx + px·qw + py·qz − pz·qy
result.y = pw·qy − px·qz + py·qw + pz·qx
result.z = pw·qz + px·qy − py·qx + pz·qw
```

**ベクトル v をクォータニオン q で回転させる:**  
数式としては `v' = q * (0,vx,vy,vz) * q⁻¹` だが、実装では下記の回転行列変換の方が高速。

**クォータニオン → 3×3 回転行列 R:**  
この R は「ローカル座標 → ワールド座標」の変換に使う。
```
R = [
  1−2(y²+z²),   2(xy−wz),    2(xz+wy)
  2(xy+wz),    1−2(x²+z²),   2(yz−wx)
  2(xz−wy),     2(yz+wx),   1−2(x²+y²)
]
```

**正規化 (毎フレーム行う):**  
積分の数値誤差でクォータニオンが「単位クォータニオン」でなくなっていくため、正規化で補正する。
```
|q| = sqrt(w²+x²+y²+z²)
q_normalized = q / |q|
```

---

### 1.3 慣性テンソル (Inertia Tensor)

**何を表すか:** 物体の「回転のしにくさ」。並進運動の「質量 m」に相当する回転版。  
3×3 の対称行列 `I` で表され、軸によって回転のしにくさが異なる場合がある。  
例: 細長い棒は長軸まわりより短軸まわりの方が回しにくい。

**角運動方程式:**
```
τ = I · α
  τ : トルク [N·m]  ← 力の「回転への効き具合」
  I : 慣性テンソル [kg·m²]
  α : 角加速度 [rad/s²]  ← どれだけ速く回転速度が変化するか
```

**シミュレーション中は逆行列 `I⁻¹` をよく使う:**  
「トルクが与えられたとき、どれだけ角加速度が生じるか」を求めるため。
```
α = I⁻¹ · τ
```

**ローカル vs ワールド:**  
慣性テンソルは物体ローカル座標で対角行列になる(主軸成分のみ)。  
ワールド座標での慣性テンソルは、物体の向き(回転行列 R)を使って変換する。
物体が回転するたびにこの変換を更新しないと慣性の方向がずれる。
```
I_world     = R · I_local     · Rᵀ
I_world_inv = R · I_local_inv · Rᵀ

  R  : 現在の向きを表す回転行列(クォータニオンから毎フレーム再計算)
  Rᵀ : R の転置行列(直交行列なので Rᵀ = R⁻¹)
```

---

## 2. 形状の定義と内部表現

コライダー(衝突判定に使う形状)とレンダリング用メッシュは別物。  
コライダーは近似形状で構わない。複雑なメッシュのまま衝突判定すると計算が爆発するため。

### 2.1 Sphere (球)

最も計算が軽い形状。解析的に全て処理できる。

**必要なデータ:**
```
center : Vec3   // 剛体重心からの局所オフセット
                // (0,0,0) なら重心と球の中心が一致
radius : float  // 球の半径 [m]
```

**支持関数 (GJKで使う):**  
「方向 d に対して形状の中で最も遠い点」を返す。球の場合、どの方向でも中心から半径分だけ進んだ点が最遠点になる。
```
support(d) = center + radius · normalize(d)
```

**慣性テンソル (質量 m, 半径 r の均一密度球):**  
球は全軸で対称なので対角成分が全て等しい。
```
I = (2/5) · m · r² · I₃
  I₃ : 3×3 単位行列
  対角成分: (2/5·m·r², 2/5·m·r², 2/5·m·r²) として格納
```
例: m=1kg, r=0.5m → 各軸 `I = 0.4 × 0.25 = 0.1 [kg·m²]`

---

### 2.2 Capsule (カプセル)

線分を「掃引」して半径 r の厚みをつけた形状。  
キャラクターコライダーによく使う理由: 角がないため段差を滑らかに乗り越えられる。

**必要なデータ:**
```
pointA : Vec3   // 内部線分の一端(ローカル座標)。例: 頭側
pointB : Vec3   // 内部線分のもう一端(ローカル座標)。例: 足側
radius : float  // 線分からの半径 [m]
```

**形状の本質:** 「線分 AB 上の全点から距離 r 以内の点の集合」= シリンダー + 両端の半球

**支持関数:**  
どちらの端点が d 方向に遠いかを内積で判断し、その端点から球と同様に radius 分進む。
```
function support(d):
    if dot(d, pointB - pointA) >= 0:
        return pointB + radius · normalize(d)
    else:
        return pointA + radius · normalize(d)
```

**慣性テンソル (軸=Y、高さ h = |pointB - pointA|、質量 m):**  
シリンダー部分と両端の半球部分の慣性を合算する。
```
m_cyl = m · (πr²h) / (πr²h + (4/3)πr³)   // 体積比で質量を分配
m_cap = m - m_cyl

// シリンダー部の慣性
I_cyl_xx = m_cyl · (r²/4 + h²/12)
I_cyl_yy = m_cyl · r²/2

// 半球部の慣性 (平行軸の定理で重心からのオフセットを補正)
I_cap_xx = m_cap · (2r²/5 + (h/2 + 3r/8)²)
I_cap_yy = m_cap · 2r²/5

Ixx = Izz = I_cyl_xx + I_cap_xx
Iyy       = I_cyl_yy + I_cap_yy
```

---

### 2.3 Box (直方体)

**必要なデータ:**
```
halfExtents : Vec3  // 各軸の「半分のサイズ」 (hx, hy, hz)
                    // 例: (1, 0.5, 2) → 幅2m, 高さ1m, 奥行き4m の箱
                    // 位置・向きは剛体の Transform から取る
```

**8頂点のローカル座標:**  
符号の組み合わせ 2³=8 通り。
```
v[i] = (±hx, ±hy, ±hz)  (全8通り)
```

**支持関数:**  
各軸について d の符号と同じ符号の頂点成分を選ぶだけ。O(1) で計算できる。  
d はワールド座標からローカル座標に変換 (`d_local = Rᵀ · d_world`) してから使い、結果をワールドに戻す。
```
support(d_local) = ( sign(d_local.x)·hx,  sign(d_local.y)·hy,  sign(d_local.z)·hz )
support_world    = position + R · support(d_local)
```

**慣性テンソル (質量 m, halfExtents = (hx,hy,hz)):**
```
Ixx = (1/3) · m · (hy² + hz²)
Iyy = (1/3) · m · (hx² + hz²)
Izz = (1/3) · m · (hx² + hy²)
```
例: m=2kg, halfExtents=(0.5, 1.0, 0.5)  
`Ixx = (1/3)·2·(1.0²+0.5²) = (2/3)·1.25 ≈ 0.833 [kg·m²]`

---

### 2.4 Plane (平面)

平らな板状のコライダー。有限サイズを持つ。  
Static かどうかは形状ではなく剛体の `bodyType` / `invMass` で決める。

**必要なデータ:**
```
normal   : Vec3   // 平面の法線方向(単位ベクトル)。「表側」を向いている
                  // 例: (0,1,0) = 水平な上向きの面
distance : float  // ワールド原点から平面までの符号付き距離
                  // 平面の方程式 n·x = distance が成立する値
halfSize : Vec2   // 平面の幅・奥行きの半分のサイズ
                  // 例: (5, 5) → 10m×10m の板
```

**平面の方程式:**  
`n · x = distance` を満たす点 x が平面上にある。

**点 p と平面の関係:**
```
signed_dist = dot(n, p) - distance
  > 0 : 点 p は平面の表側(法線側)にある
  = 0 : 点 p は平面上にある
  < 0 : 点 p は平面の裏側にある(貫通している)
penetration = -signed_dist   // 正なら貫通量
```

**慣性テンソル (厚みのある板として):**
```
Ixx = (1/3) · m · hz²
Iyy = (1/3) · m · (hx² + hz²)
Izz = (1/3) · m · hx²
```

---

### 2.5 Polyhedron (多面体)

頂点を追加して任意の多面体形状を作る。凸形状とは限らない。  
**凹形状の場合は GJK を直接使えない** → 凸分解が必要(後述)。

**必要なデータ:**
```
vertices : Vec3[]     // 頂点座標のリスト(ローカル座標)
faces    : Face[]     // 各面の情報
    face.vertexIndices : int[]   // この面を構成する頂点のインデックス
    face.normal        : Vec3    // この面の法線(外向き)
edges    : Edge[]     // エッジのリスト
    edge.vertexA, edge.vertexB : int   // 両端の頂点インデックス
```

**凸包生成 (Quickhull アルゴリズム):**  
与えられた頂点群から「全点を内包する最小の凸形状」を生成する。

```
手順:
1. 最も x が大きい点と小さい点を選び、初期の「辺」とする
2. その辺から最も遠い点を追加して三角形を作る
3. さらにその三角形から最も遠い点を追加し四面体を作る(初期形状)
4. 各面について「面の外側にある点」をリストアップ
5. 外側点がある面を選び、その面から最も遠い点 p を取得
6. p から見える全ての面を削除し、境界エッジに p を結んで新しい面を生成
7. 全ての面に外側点がなくなるまで 5-6 を繰り返す
```

**支持関数 (GJKで使う):**  
全頂点の中で方向 d への内積が最大の点を返す。O(n) かかる。
```
function support(d):
    maxDot = -∞;  result = vertices[0]
    for v in vertices:
        val = dot(v, d)
        if val > maxDot:  maxDot = val;  result = v
    return result
```

**慣性テンソル (テトラヘドロン分解):**  
メッシュを四面体に分解して各慣性テンソルを合算する(符号付き体積を使えば凹形状でも正しく計算される)。

---

### 2.6 Cylinder (円柱)

**必要なデータ:**
```
radius : float   // 底面の半径 [m]
height : float   // 高さ [m](軸方向の全長)
axis   : Vec3    // 軸の方向(ローカル座標)。通常 (0,1,0)
```

**支持関数:**  
軸方向と軸垂直方向の成分を分けて計算する。
```
function support(d):
    d_axis = dot(d, axis)
    axisOffset   = (height/2) · axis · sign(d_axis)
    d_perp       = d - d_axis · axis
    len          = length(d_perp)
    circleOffset = (len > 0) ? (radius/len) · d_perp : Vec3(0,0,0)
    return axisOffset + circleOffset
```

**慣性テンソル (軸=Y、質量 m、半径 r、高さ h):**
```
Ixx = Izz = m · (3r² + h²) / 12
Iyy       = m · r² / 2
```

---

### 2.7 Cone (円錐)

**必要なデータ:**
```
radius : float   // 底面の半径 [m]
height : float   // 高さ [m]
axis   : Vec3    // 頂点から底面方向の軸(ローカル)
```

**慣性テンソル (軸=Y、質量 m、半径 r、高さ h):**
```
Ixx = Izz = 3m(4r² + h²) / 80
Iyy       = (3/10) · m · r²
```

---

### 2.8 Compound (複合形状)

1つの剛体に複数のコライダーをアタッチする。

**必要なデータ:**
```
shapes : SubShape[]
    subShape.collider     : Shape       // 任意の形状
    subShape.localOffset  : Vec3        // 剛体重心からのオフセット
    subShape.localOrient  : Quaternion  // ローカル座標内での向き
```

**慣性テンソルの合算 (平行軸の定理):**  
各サブ形状の慣性テンソルを重心からのオフセットで補正して合算する。
```
// r_i: サブ形状 i の重心から剛体重心へのオフセットベクトル
I_total += I_i + m_i · (dot(r_i, r_i)·I₃ - outer(r_i, r_i))
// outer(r_i, r_i): テンソル積(3×3行列)
```

---

## 3. 剛体の状態管理

### 3.1 BodyType (物体の種類)

**形状ではなく剛体のパラメータで動作を決める。**

```
enum BodyType {
    DYNAMIC,   // 力・衝突によって動く。mass と inertia が有限
    KINEMATIC, // スクリプトが直接速度を制御する。衝突で動かないが他物体を押す
               // 例: 動くエレベーター、ドア
    STATIC,    // 完全に動かない。質量が実質無限大
               // 例: 地形、固定された壁
}
```

**invMass による統一表現:**
```
DYNAMIC   : invMass = 1/mass  (正の値)
KINEMATIC : invMass = 0  かつ速度は外部から設定
STATIC    : invMass = 0  かつ速度も 0
```
インパルス計算式に `invMass=0` を代入すると自動的に「動かない」になる。

---

### 3.2 RigidBody の全状態量

```
struct RigidBody {
    bodyType     : BodyType    // DYNAMIC / KINEMATIC / STATIC

    // 位置・姿勢
    position     : Vec3        // 重心のワールド座標 [m]
    orientation  : Quaternion  // 現在の向き

    // 速度
    linearVel    : Vec3        // 線速度 [m/s]
    angularVel   : Vec3        // 角速度 [rad/s] 方向=回転軸、大きさ=速さ

    // 質量・慣性
    mass         : float       // 質量 [kg]。STATIC/KINEMATIC は ∞ 扱い
    invMass      : float       // 1/mass。STATIC/KINEMATIC は 0
    I_local      : Mat3x3      // ローカル座標での慣性テンソル [kg·m²]
    I_local_inv  : Mat3x3      // その逆行列
    I_world_inv  : Mat3x3      // ワールド座標での慣性テンソル逆行列(毎フレーム更新)

    // 力の蓄積バッファ(1フレーム内で addForce() が何度も呼ばれるため積算する)
    forceAccum   : Vec3        // このフレームの合力 [N]
    torqueAccum  : Vec3        // このフレームの合トルク [N·m]

    // 素材プロパティ
    restitution  : float       // 反発係数 0〜1 (0=完全非弾性, 1=完全弾性)
    friction     : float       // 摩擦係数 μ (0=なし, 1=強い)

    // 減衰
    linearDamping  : float     // 線速度の減衰率。空気抵抗の近似。例: 0.01
    angularDamping : float     // 角速度の減衰率。例: 0.05

    // コライダー
    colliders    : Collider[]  // アタッチされたコライダーのリスト

    // スリープ管理
    isAwake      : bool
    sleepTimer   : float       // 低速状態が続いた秒数
}
```

---

### 3.3 力の適用

**重心に力 F を加える:**
```
forceAccum += F   // 回転は起こさない
```

**ワールド座標の点 p に力 F を加える:**  
`r = p - body.position` (力の作用点から重心へのベクトル = 「腕」)
```
forceAccum  += F
torqueAccum += cross(r, F)   // r × F = トルク
```

**計算例:**  
重心位置=(0,0,0)、作用点=(0.5,0,0)、力=(0,10,0) の場合:  
`torque = cross((0.5,0,0),(0,10,0)) = (0·0−0·10, 0·0.5−0.5·0, 0.5·10−0·0) = (0,0,5)` [N·m]  
→ Z軸まわりに 5 N·m のトルクが生じる。

---

### 3.4 スリープシステム

動いていない物体を毎フレームのシミュレーションから除外する。

```
THRESHOLD_LINEAR  = 0.05 [m/s]
THRESHOLD_ANGULAR = 0.05 [rad/s]
SLEEP_TIME        = 0.5  [秒]

function updateSleep(body, dt):
    if body.bodyType != DYNAMIC: return

    if length(body.linearVel) < THRESHOLD_LINEAR
    AND length(body.angularVel) < THRESHOLD_ANGULAR:
        body.sleepTimer += dt
        if body.sleepTimer >= SLEEP_TIME:
            body.isAwake = false
            body.linearVel = body.angularVel = (0,0,0)
    else:
        body.sleepTimer = 0
        body.isAwake = true
```

---

## 4. 運動の積分

積分とは「現在の速度・力から、次のフレームの位置・速度を計算する」処理。

### 4.1 ニュートンの運動方程式

```
a = F_total · invMass         // 線加速度 = 合力 × 質量の逆数
α = I_world_inv · τ_total    // 角加速度 = 慣性逆行列 × 合トルク
```

### 4.2 半陰的オイラー法 (Symplectic Euler)

単純オイラー法 (`x += v_old·dt`) はエネルギーが増大して不安定になる。  
半陰的オイラー法は「速度を先に更新し、その新しい速度で位置を更新する」。これだけでエネルギー保存性が大幅に改善される。

```
// ワールド慣性テンソルを現在の向きで更新
R = quaternionToMatrix(body.orientation)
body.I_world_inv = R · body.I_local_inv · transpose(R)

// ステップ1: 加速度の計算
a = body.forceAccum · body.invMass + GRAVITY
α = body.I_world_inv · body.torqueAccum

// ステップ2: 速度を先に更新(半陰的オイラーのポイント)
body.linearVel  += a · dt
body.angularVel += α · dt

// ステップ3: 減衰の適用(粘性抵抗・数値安定化)
body.linearVel  *= clamp(1 - body.linearDamping  · dt, 0, 1)
body.angularVel *= clamp(1 - body.angularDamping · dt, 0, 1)

// ステップ4: 位置・姿勢の更新(更新済みの速度を使う)
body.position += body.linearVel · dt

// クォータニオンの角速度積分: dq/dt = 0.5 · ω_q · q
// ω_q は角速度の純虚クォータニオン (0, ωx, ωy, ωz)
ω_q = Quaternion(0, body.angularVel.x, body.angularVel.y, body.angularVel.z)
body.orientation += 0.5 · (ω_q * body.orientation) · dt
body.orientation  = normalize(body.orientation)

// ステップ5: 力バッファをリセット
body.forceAccum  = body.torqueAccum = (0,0,0)
```

**計算例:**  
`mass=1kg`, `gravity=(0,−9.8,0)`, `dt=1/60≈0.0167s`  
`a = (0,−9.8,0)`、1フレーム後: `linearVel = (0,−0.163,0)` [m/s]

---

## 5. ブロードフェーズ衝突検出

**目的:** ナローフェーズ(GJK等)の高精度判定は1ペアでも計算コストが高い。まず「重なる可能性があるペア」だけを大まかに絞り込む。

### 5.1 AABB (Axis-Aligned Bounding Box)

物体を「座標軸に平行な直方体」で包む。回転なし。  
判定が 6回の数値比較だけなので非常に速い。

**必要なデータ:**
```
min : Vec3   // 直方体の最小座標 (x_min, y_min, z_min)
max : Vec3   // 直方体の最大座標 (x_max, y_max, z_max)
```

**各形状からの AABB 生成:**
```
// Sphere
aabb.min = center - Vec3(radius, radius, radius)
aabb.max = center + Vec3(radius, radius, radius)

// Box (回転あり): 回転行列 R の各成分の絶対値を使って最大の広がりを計算
e.x = |R[0][0]|·hx + |R[0][1]|·hy + |R[0][2]|·hz
e.y = |R[1][0]|·hx + |R[1][1]|·hy + |R[1][2]|·hz
e.z = |R[2][0]|·hx + |R[2][1]|·hy + |R[2][2]|·hz
aabb.min = position - e;  aabb.max = position + e

// Capsule: 両端点から radius 分拡張
pA_world = position + R · pointA;  pB_world = position + R · pointB
aabb.min = componentMin(pA_world, pB_world) - Vec3(radius,radius,radius)
aabb.max = componentMax(pA_world, pB_world) + Vec3(radius,radius,radius)

// Polyhedron: 全頂点のワールド座標を計算してmin/max
aabb.min = aabb.max = R·vertices[0] + position
for v in vertices:
    v_world = R·v + position
    aabb.min = componentMin(aabb.min, v_world)
    aabb.max = componentMax(aabb.max, v_world)
```

**AABB 同士の重なり判定:**  
1軸でも隙間があれば交差しない(分離軸定理の特殊ケース)。
```
function overlapsAABB(a, b) → bool:
    if a.min.x > b.max.x OR a.max.x < b.min.x: return false
    if a.min.y > b.max.y OR a.max.y < b.min.y: return false
    if a.min.z > b.max.z OR a.max.z < b.min.z: return false
    return true
```

### 5.2 Bounding Sphere (外接球)

sqrt を使わず二乗比較だけで判定できる。
```
function overlapsBoundingSphere(a_center, a_r, b_center, b_r) → bool:
    dist_sq = dot(b_center - a_center, b_center - a_center)
    r_sum   = a_r + b_r
    return dist_sq <= r_sum · r_sum
```

### 5.3 ブロードフェーズのデータ構造

| 手法 | 計算量 | 特徴 |
|------|--------|------|
| 総当り | O(n²) | 実装最簡単。物体数 < 50 |
| Sort & Sweep (SAP) | O(n log n) | 1軸でソート、動的シーン向き |
| BVH | O(log n) クエリ | 木構造、静的物体多いシーン向き |
| Spatial Hash | O(1) 平均 | グリッド分割、均一サイズ物体向き |

---

## 6. ナローフェーズ衝突検出 — GJK と EPA

### 6.1 解析的判定 (特殊ペアの高速処理)

GJKより計算が速いため、対応しているペアでは優先的に使う。

**Sphere vs Sphere:**

2球の中心間距離を求め、それが「2つの半径の合計」より小さければ交差している。  
距離の計算に sqrt を使うが、交差判定だけなら二乗比較でも可。

```
diff     = posB - posA
dist_sq  = dot(diff, diff)
r_sum    = radiusA + radiusB
if dist_sq >= r_sum · r_sum: 交差なし

// 交差あり → 詳細を計算
dist    = sqrt(dist_sq)
normal  = diff / dist            // A→B 方向の単位法線
depth   = r_sum - dist           // 貫通深度
contact = posA + normal · (radiusA - depth/2)
```

**Sphere vs Plane:**

球の中心から平面への符号付き距離を求める。球の半径より小さければ交差。

```
// 平面の方程式: dot(n, x) = d  (n は法線、d は原点からの距離)
signed_dist = dot(plane.normal, sphereCenter) - plane.distance
if signed_dist >= sphere.radius: 交差なし  // 完全に表側

depth   = sphere.radius - signed_dist
normal  = plane.normal
contact = sphereCenter - normal · sphere.radius
```

**Capsule vs Sphere:**

カプセルの「内部線分」上で、球の中心に最も近い点を求める。  
その点と球の中心の距離が「カプセル半径 + 球半径」より小さければ交差。

線分上の最近傍点の求め方: 球の中心 C を線分 AB に投影したパラメータ t を求め、0〜1 にクランプして点を得る。

```
// 線分 AB 上で C に最も近い点 P を求める
t = dot(C - A, B - A) / dot(B - A, B - A)
t = clamp(t, 0, 1)
P = A + t · (B - A)
// P と C の距離が (capsule.radius + sphere.radius) より小さいか判定
```

| ペア | 手法 |
|------|------|
| Sphere vs Sphere | 解析的(上記) |
| Sphere vs Plane | 解析的(上記) |
| Sphere vs Box | 箱上の最近傍点を求めてから距離判定 |
| Capsule vs Sphere | 線分-点の最近傍(上記) |
| Capsule vs Capsule | 線分-線分の最近傍距離 |
| Capsule vs Plane | 両端点と平面の距離判定 |
| Box vs Plane | 8頂点と平面の距離判定 |
| Any Convex vs Any Convex | GJK + EPA |

---

### 6.2 GJK アルゴリズム

#### ミンコフスキー差とは何か

GJKの核心にある概念。2つの形状 A, B のミンコフスキー差とは、  
「A の任意の点 a」と「B の任意の点 b」の差 `(a - b)` を全組み合わせで集めた点の集合のこと。

```
A ⊖ B = { a - b  |  a ∈ A,  b ∈ B }
```

**なぜこれが重要か:**  
「A と B が交差している」は「A ⊖ B が原点 (0,0,0) を含む」と数学的に等価になる。  
直感的に説明すると、A と B が接触しているとき「A のある点 a と B のある点 b が一致する (a = b)」、  
つまり `a - b = 0` となる点が存在する = 原点が A ⊖ B の中にある、ということ。

**問題の変換:**  
A と B の衝突判定 → A ⊖ B という1つの形状に原点が含まれるかの判定、に変換される。

**支持関数でミンコフスキー差の表面上の点を得る:**  
方向 d に対して A ⊖ B 上で最も遠い点は次の式で求められる:
```
support_AB(d) = support_A(d) - support_B(-d)
```
「A の d 方向の最遠点」から「B の -d 方向の最遠点(= B の d 方向の最近点)」を引く。  
これを使えば A ⊖ B を明示的に構築しなくても、その表面上の点を得られる。

---

#### シンプレックスとは何か

**シンプレックス(Simplex)**とは、GJK が内部で使う「点の集合」のこと。  
具体的には 1〜4点で構成され、それぞれに対応した幾何学的形状がある。

```
点の数  形状名      意味
1点   = 点 (Point)
2点   = 線分 (Line Segment)
3点   = 三角形 (Triangle)
4点   = 四面体 (Tetrahedron)
```

GJK は「原点を囲もうとしている点の集合」として、このシンプレックスを反復的に更新していく。  
各ステップで「ミンコフスキー差 A ⊖ B の表面上の新しい点」をシンプレックスに追加し、  
そのシンプレックスが原点を含むかどうかを確認する。

3Dにおいて点の集合が「原点を囲む」ためには最大4点(四面体)あれば十分。  
なぜなら3次元空間で1点を囲むには最小で四面体が必要だから。

---

#### GJK の反復処理の全体像

GJKが「交差しているか」を判定する大まかな流れ:

1. **探索方向 d を決める。** 最初は「B の中心 − A の中心」を正規化したベクトルを使う。これが最初の探索方向。

2. **その方向 d でミンコフスキー差の表面上の点を1つ取得する。** これを「新しい支持点」と呼ぶ。`new_point = support_A(d) - support_B(-d)`

3. **「原点に到達できるか」を確認する。** 新しい支持点と方向 d の内積が 0 未満なら、その方向に A⊖B の境界が存在しない。つまり原点はこの方向にはなく、交差していない。→ 終了(交差なし)

4. **新しい支持点をシンプレックスに追加する。**

5. **シンプレックスを整理する(doSimplex)。** シンプレックスの中で「原点に最も近い部分」を特定し、不要な点を取り除く。そして次の探索方向 d を「その最近傍部分から原点への方向」に設定する。もしシンプレックスが原点を含んでいれば終了(交差あり)。

6. **2 に戻る。** 収束しない場合に備えて最大イテレーション数(例:64回)を設ける。

```
function GJK(shapeA, shapeB) → (bool intersecting, Simplex result_simplex):

    // Step 1: 初期探索方向 = B中心からA中心を引いた方向の正規化
    d = normalize(shapeB.position - shapeA.position)
    simplex = 空

    for iteration in 0..64:
        // Step 2: ミンコフスキー差上の新頂点
        new_point = support_AB(d)

        // Step 3: 到達不可能チェック
        // dot(new_point, d) < 0 は「new_point が原点より d の後方にある」ことを意味する
        // = A⊖B はこの方向には原点まで届かない
        if dot(new_point, d) < 0:
            return (false, _)

        // Step 4: シンプレックスに追加
        simplex.add(new_point)

        // Step 5: シンプレックスを整理し次の探索方向を決定
        (d, contains_origin) = doSimplex(simplex)
        if contains_origin:
            return (true, simplex)

    return (false, _)   // 収束しなかった = 交差なしとして扱う
```

---

#### doSimplex — シンプレックスの整理と次方向の決定

doSimplex は「現在のシンプレックスを使って、原点に最も近い部分集合を特定し、  
次の探索方向を返す」処理。これが GJK の中で最も複雑な部分。

**重要な概念: Voronoi 領域**  
シンプレックスの各部分(頂点・辺・面)には「Voronoi 領域」という概念がある。  
ある点 P の「Voronoi 領域」とは、P がシンプレックス上で最近傍となる空間の領域のこと。  
例えば線分 AB において、B の Voronoi 領域は「AB の延長線上、B より外側」の領域。

doSimplex では原点がどの部分の Voronoi 領域にあるかを内積で判定し、  
その部分に向かって次の探索方向を設定する。

---

##### ケース1: シンプレックスが「線分」(2点) の場合

**点の名前:** A = 今追加した最新点、B = 前のステップで追加した点

**何を求めるか:** 原点 O が「B のみの Voronoi 領域」「AB の辺の Voronoi 領域」どちらにあるかを判定する。

**判定の考え方:**  
AB ベクトルと AO ベクトル(A から原点への方向)の内積を取る。  
内積が正なら原点は「A から見て B の方向にある」= 線分 AB の Voronoi 領域にある。  
内積が負なら原点は「A の反対側」= A の頂点 Voronoi 領域にある(B は不要)。

**次の探索方向の求め方(線分の Voronoi 領域に原点がある場合):**  
原点 O を AB 上に投影した点への方向が最短距離の方向だが、それは次の式で求められる。  
`cross(cross(AB, AO), AB)` = AB に垂直で、かつ AO 成分を持つベクトル。  
これが「線分 AB から原点に向かう最短方向」になる。

```
AB = B - A      // A から B へのベクトル
AO = -A         // A から原点へのベクトル (= 0 - A)

if dot(AB, AO) > 0:
    // 原点は線分 AB の Voronoi 領域 → 両点を保持
    simplex = {A, B}
    d = cross(cross(AB, AO), AB)   // AB ⊥ 方向で AO 成分を持つ方向
else:
    // 原点は A 側の頂点 Voronoi 領域 → B は不要
    simplex = {A}
    d = AO
```

---

##### ケース2: シンプレックスが「三角形」(3点) の場合

**点の名前:** A = 最新点、B = 2番目、C = 最古点

**何を求めるか:** 原点 O が、三角形の外側(どの辺の Voronoi 領域)にあるか、  
あるいは三角形の真上/真下(三角形の面の Voronoi 領域)にあるかを判定する。

**判定の考え方:**  
まず三角形 ABC の面法線を求める: `ABC_normal = cross(AB, AC)`  
次に「各辺の外向きベクトル」を使って原点がどちら側にあるかを確認する。

具体的には「辺 AC の外向き法線 = cross(ABC_normal, AC)」と AO の内積を取る。  
正なら原点は辺 AC の外側にある。  
同様に「辺 AB の外向き法線 = cross(AB, ABC_normal)」でも確認する。

最終的に面の上下どちらかにあることが判明した場合は、面法線 or 逆法線を次の方向に使う。

```
AB = B - A;  AC = C - A;  AO = -A
ABC_normal = cross(AB, AC)   // 三角形の面法線(外向き)

// AC の外側か判定
if dot(cross(ABC_normal, AC), AO) > 0:
    // 原点は AC の外側にある
    if dot(AC, AO) > 0:
        // AC 方向に原点がある → B は不要、AC の線分に縮退
        simplex = {A, C}
        d = cross(cross(AC, AO), AC)
    else:
        // AB の線分ケースへ (A, B で再判定)
        simplex = {A, B}
        → 線分ケースの処理を適用
else:
    // AB の外側か判定
    if dot(cross(AB, ABC_normal), AO) > 0:
        simplex = {A, B}
        → 線分ケースの処理を適用
    else:
        // 原点は三角形の面の Voronoi 領域(上か下か)
        if dot(ABC_normal, AO) > 0:
            // 原点は面の表側 → 法線方向に探索
            simplex = {A, B, C}
            d = ABC_normal
        else:
            // 原点は面の裏側 → 巻き順を逆にして裏返す
            simplex = {A, C, B}
            d = -ABC_normal
```

---

##### ケース3: シンプレックスが「四面体」(4点) の場合

**点の名前:** A = 最新点、B・C・D = 前の3点

**何を求めるか:** 原点 O が四面体の内部にあるか、外部(どの面の外側)にあるかを判定する。

**判定の考え方:**  
四面体には A を含む3つの面がある(面 ABC、面 ACD、面 ADB)。  
各面について「法線方向(外向き)に原点があるか」を確認する。  
外向き法線と AO の内積が正なら「原点はその面の外側にある」。

原点がどの面の外側にもない場合 → 四面体が原点を囲んでいる → 交差確定。

面の法線の向きに注意: 四面体の巻き順(頂点の並び順)によって外向き/内向きが決まる。  
四面体を作るときに「全ての面法線が外を向く」ように一貫した巻き順を維持すること。

```
// A を共有する 3面の外向き法線
ABC = cross(AB, AC)
ACD = cross(AC, AD)
ADB = cross(AD, AB)
AO = -A

if dot(ABC, AO) > 0:
    // 原点は面 ABC の外側 → 四面体を面 ABC の三角形に縮退
    simplex = {A, B, C}
    → 三角形ケースへ
elif dot(ACD, AO) > 0:
    simplex = {A, C, D}
    → 三角形ケースへ
elif dot(ADB, AO) > 0:
    simplex = {A, D, B}
    → 三角形ケースへ
else:
    // 全面の内側 = 四面体が原点を含む → 交差確定
    contains_origin = true
```

---

### 6.3 EPA (Expanding Polytope Algorithm)

#### EPA が必要な理由

GJK は「交差しているかどうか」しかわからない。  
衝突応答では「どれだけめり込んでいるか(貫通深度)」と「どの方向に押し返すか(衝突法線)」が必要。  
EPA はこれを求めるためのアルゴリズム。

#### EPA の基本アイデア

GJK が「交差あり」と判定したとき、最後のシンプレックス(四面体)の中に原点がある。  
この四面体は A ⊖ B(ミンコフスキー差)の内部に収まっている。

「貫通深度」= 原点から A ⊖ B の表面までの最短距離、に等しい。  
なぜなら A ⊖ B の表面上の点 p は「その方向 p/|p| での支持点」であり、  
原点からその点まで押せば形状が「ちょうど接触だけしている」状態になるから。

EPA はその最短距離を求めるために、四面体から出発して A ⊖ B の表面を少しずつ「外側に広げて(Expand)」いく。

#### EPA の具体的な手順

**概念的な流れ:**  
1. GJK の四面体から始める
2. 全ての面の中で「原点からの距離が最小の面」を選ぶ。これが現在の「最小貫通候補」
3. その面の法線方向に新しい支持点を取得する
4. 新しい支持点がその面よりも外側にあれば、まだポリトープを広げられる → 面を更新
5. 新しい支持点がほぼ面上にある(距離差が閾値未満)なら収束 → その法線と距離が答え

**ポリトープの更新方法:**  
新しい点 p を追加するとき、p から「見える」面(p が面の外側にある面)を全て削除する。  
削除した面の外縁エッジ(境界線)を特定し、それぞれと p を結んで新しい三角形面を生成する。

```
function EPA(shapeA, shapeB, simplex) → (Vec3 normal, float depth):

    // 初期ポリトープ = GJK の四面体の各面を法線と距離でリスト化
    faces = []
    for each triangular face of simplex:
        n   = normalize(cross(edge1, edge2))   // 外向き法線
        d   = dot(n, face_vertex)              // 原点からの距離
        faces.append({normal: n, dist: d, vertices: ...})

    // 収束するまで反復
    for _ in 0..MAX_EPA_ITERS:

        // ステップ1: 原点に最も近い面を選ぶ(= 最小貫通方向の候補)
        closest = faces の中で dist が最小のもの

        // ステップ2: その面の法線方向に支持点を取得
        p = support_AB(closest.normal)

        // ステップ3: 収束チェック
        // dot(p, closest.normal) = 支持点の法線方向成分
        // closest.dist = 面の原点からの距離
        // 差が小さい = 支持点がほぼ面上にある = これ以上広がらない
        if dot(p, closest.normal) - closest.dist < 0.001:
            return (closest.normal, dot(p, closest.normal))

        // ステップ4: p から見える面を削除し、新しい面を生成
        visible = []
        for face in faces:
            if dot(face.normal, p - face.vertex) > 0:
                visible.append(face)   // p から見える面

        // 境界エッジ(可視面の外縁)を求める
        silhouette = computeSilhouetteEdges(visible)

        // 各境界エッジと p を結んで新しい面を生成
        faces.remove(visible)
        for edge in silhouette:
            new_normal = normalize(cross(edge.v1 - p, edge.v0 - p))
            new_dist   = dot(new_normal, p)
            faces.append({normal: new_normal, dist: new_dist, ...})
```

---

## 7. 衝突情報 (Contact Manifold)

### 7.1 なぜ複数の接触点が必要か

GJK + EPA は「1点の衝突情報」しか返さない。  
しかし箱が床に置かれているとき、実際の接触は「面」全体であり、  
4つの頂点がそれぞれ接触点になる。1点だけでは箱が傾いて不安定になる。

**安定したスタッキング(積み重ね)には最大4点の接触点が必要。**

---

### 7.2 衝突情報の構造

```
struct ContactPoint {
    worldPos       : Vec3    // 衝突点のワールド座標(インパルスの作用点)
    normal         : Vec3    // 衝突法線(B→A 方向の単位ベクトル)
    penetration    : float   // 貫通深度(位置修正で「この量だけ離す」ために使う)
    r_A            : Vec3    // 物体 A の重心から衝突点へのベクトル(インパルス計算用)
    r_B            : Vec3    // 物体 B の重心から衝突点へのベクトル(インパルス計算用)
    normalImpulse  : float   // 蓄積された法線インパルス λ_n (ウォームスタート用)
    tangentImpulse : Vec2    // 蓄積された接線インパルス λ_t1, λ_t2 (ウォームスタート用)
}

struct ContactManifold {
    bodyA       : RigidBody*
    bodyB       : RigidBody*
    contacts    : ContactPoint[]   // 1〜4点
    normal      : Vec3             // 代表法線
    friction    : float            // sqrt(bodyA.friction · bodyB.friction)
    restitution : float            // min(bodyA.restitution, bodyB.restitution)
}
```

---

### 7.3 クリッピング法による接触点群の生成

EPA で得た「1点の衝突情報」から複数の接触点を生成する方法。  
Sutherland-Hodgman アルゴリズムをベースにしている。

**手順の概念:**

1. **参照面 (Reference Face) を特定する。**  
   EPA の衝突法線 n に最も近い法線を持つ面を「参照面」として選ぶ。  
   「最も近い」= 法線の内積が最大の面。

2. **入射面 (Incident Face) を特定する。**  
   相手の形状で、参照面と最も向き合っている面を選ぶ。  
   「最も向き合っている」= 法線が参照面法線と反対方向に近い面(内積が最も負の面)。

3. **入射面の頂点多角形を参照面の各辺でクリッピングする。**  
   参照面の各辺を「クリッピング平面」として使い、入射面の多角形を切り取る。  
   Sutherland-Hodgman は「平面の外側にある頂点を取り除き、辺と平面の交点を新たな頂点として追加する」操作を各辺に順に適用する。

4. **参照面に投影する。**  
   クリッピング結果の各点を参照面の法線方向に投影する。  
   参照面の裏側(負の距離)にある点は「まだめり込んでいる」点なので、その距離が貫通深度になる。

5. **4点に削減する。**  
   接触点が4点を超える場合、「面積が最大になる4点」を選ぶ。  
   最も遠い点を1つ選び、そこから最も面積が広がる順に3点を追加する。

```
function generateContactManifold(shapeA, shapeB, epa_normal, epa_depth):

    // ステップ1: 参照面の選択
    ref_face = shapeA.face で dot(face.normal, epa_normal) が最大のもの

    // ステップ2: 入射面の選択
    inc_face = shapeB.face で dot(face.normal, epa_normal) が最小(最も反対)のもの

    // ステップ3: Sutherland-Hodgman クリッピング
    clipped_poly = inc_face.polygon
    for each edge of ref_face:
        clip_plane_normal = ref_face の辺の外向き法線
        clipped_poly = sutherlandHodgmanClip(clipped_poly, clip_plane_normal)

    // ステップ4: 参照面への投影と貫通深度の計算
    contacts = []
    for each point p in clipped_poly:
        dist = dot(ref_face.normal, p) - ref_face.distance
        if dist < 0:   // 参照面より裏側にある = 貫通している点
            contacts.append(ContactPoint {
                worldPos    = p,
                penetration = -dist,
                normal      = epa_normal
            })

    // ステップ5: 4点に削減
    if contacts.count > 4:
        contacts = reduceTo4Points(contacts)

    return contacts
```

---

### 7.4 ウォームスタート (Warm Starting)

**目的:** PGS ソルバーの収束を早め、少ないイテレーション数でも安定させる。  
**方法:** 前フレームで蓄積したインパルス値を、次フレームの初期インパルスとして再適用する。

**接触点のマッチング:**  
フレームをまたいで「同じ接触点」を対応付けるために位置で判定する。  
距離が 0.02m 以内なら「同じ接触点」とみなし、前フレームのインパルスを引き継ぐ。  
新規接触点は `normalImpulse = 0, tangentImpulse = (0,0)` からスタート。

```
function warmStart(manifold):
    for each contact c:
        J_n  = c.normalImpulse   · manifold.normal
        J_t1 = c.tangentImpulse.x · tangent1
        J_t2 = c.tangentImpulse.y · tangent2
        total = J_n + J_t1 + J_t2
        bodyA.linearVel  -= total · bodyA.invMass
        bodyA.angularVel -= bodyA.I_world_inv · cross(c.r_A, total)
        bodyB.linearVel  += total · bodyB.invMass
        bodyB.angularVel += bodyB.I_world_inv · cross(c.r_B, total)
```

---

## 8. 衝突応答 — インパルスベース

**目的:** 交差した2物体が「反発・摩擦」によってどのように速度が変化するかを計算し、即座に速度を修正する。

### 8.1 相対速度の計算

接触点において「A から見た B の速度」を求める。  
物体は回転しているため、重心の速度だけでなく「回転によって接触点が動く速度」も加味する。  
角速度 ω と重心からの腕 r の外積 `cross(ω, r)` が回転による接触点の速度になる。

```
r_A = contactPoint.worldPos - bodyA.position   // A の重心から接触点へのベクトル
r_B = contactPoint.worldPos - bodyB.position   // B の重心から接触点へのベクトル

vel_A = bodyA.linearVel + cross(bodyA.angularVel, r_A)   // 接触点での A の速度
vel_B = bodyB.linearVel + cross(bodyB.angularVel, r_B)   // 接触点での B の速度

v_rel = vel_B - vel_A    // A に対する B の相対速度

v_n = dot(v_rel, normal)   // 法線方向の相対速度成分
// v_n < 0 : 接近中 → インパルスを適用
// v_n >= 0: 離れている → 処理不要
if v_n >= 0: return
```

---

### 8.2 有効質量 (Effective Mass)

インパルス J を加えたとき「法線方向の相対速度がどれだけ変化するか」の係数。  
並進の寄与(invMass)と回転の寄与(慣性テンソル)の両方が含まれる。  
「インパルスに対する速度変化のしやすさ」を表す。

**計算の意味を分解する:**  
- `cross(r_A, n)` : r_A と n の外積 = A においてインパルス J = j·n を加えたときの回転軸
- `I_A_inv · cross(r_A, n)` : そのトルクによって生じる角加速度
- `cross(I_A_inv · cross(r_A, n), r_A)` : その角速度変化が接触点で生む速度変化
- `dot(n, ...)` : その速度変化の法線方向成分

```
K = bodyA.invMass + bodyB.invMass
  + dot(n, cross(bodyA.I_world_inv · cross(r_A, n), r_A))
  + dot(n, cross(bodyB.I_world_inv · cross(r_B, n), r_B))
```

---

### 8.3 法線インパルスの計算と適用

**インパルスの大きさを求める:**  
「衝突後の法線方向相対速度が `−e · v_n` になる」という条件から逆算する。  
e = 0 なら衝突後の相対速度はゼロ(くっつく)、e = 1 なら `-v_n`(完全に跳ね返る)。

```
e = min(bodyA.restitution, bodyB.restitution)

// インパルスの大きさ
j = -(1 + e) · v_n / K

// PGS での累積クランプ: 法線インパルスは押す方向(正)のみ
j_old = contact.normalImpulse
contact.normalImpulse = max(0, j_old + j)
j = contact.normalImpulse - j_old   // 実際に適用する量

// 速度に適用
J = j · normal
bodyA.linearVel  -= J · bodyA.invMass
bodyA.angularVel -= bodyA.I_world_inv · cross(r_A, J)
bodyB.linearVel  += J · bodyB.invMass
bodyB.angularVel += bodyB.I_world_inv · cross(r_B, J)
```

**計算例:**  
`mA=mB=1kg`, `e=0.5`, `v_n=−2m/s`, `K=2`(回転なしの簡略ケース)  
`j = −(1+0.5)·(−2)/2 = 1.5 [N·s]` → 各物体の速度が法線方向に ±1.5 m/s 変化

---

### 8.4 摩擦インパルスの計算と適用

摩擦は接触面に沿った方向(接線方向)の相対運動を妨げる力。  
法線方向以外の「滑り」を止めようとする。

**接線方向の求め方:**  
相対速度 v_rel から法線方向成分 `v_n · normal` を引いた残りが接線成分。  
それを正規化して接線単位ベクトル tangent を得る。

```
v_t = v_rel - v_n · normal          // 接線方向の相対速度ベクトル
if length(v_t) < 1e-6: return       // すべりがほぼゼロ → 摩擦計算不要
tangent = normalize(v_t)

// 接線方向の有効質量の逆数(法線と同じ形式)
K_t = bodyA.invMass + bodyB.invMass
    + dot(tangent, cross(bodyA.I_world_inv · cross(r_A, tangent), r_A))
    + dot(tangent, cross(bodyB.I_world_inv · cross(r_B, tangent), r_B))

// 接線方向のインパルス(相対速度をゼロにするのに必要な量)
jt_raw = -dot(v_rel, tangent) / K_t
```

**クーロン摩擦モデル:**  
「摩擦力は法線力の μ 倍を超えられない」という物理的制約。  
静止摩擦: `|jt| ≤ μ · j` の範囲内なら滑らない。  
動摩擦: 範囲を超えたら `μ · j` にクランプする。

```
μ = manifold.friction   // sqrt(μ_A · μ_B) で事前計算済み

// PGS での累積クランプ
jt_old = contact.tangentImpulse.x
contact.tangentImpulse.x = clamp(jt_old + jt_raw,
                                  -μ · contact.normalImpulse,
                                   μ · contact.normalImpulse)
jt = contact.tangentImpulse.x - jt_old

Jt = jt · tangent
bodyA.linearVel  -= Jt · bodyA.invMass
bodyA.angularVel -= bodyA.I_world_inv · cross(r_A, Jt)
bodyB.linearVel  += Jt · bodyB.invMass
bodyB.angularVel += bodyB.I_world_inv · cross(r_B, Jt)
```

---

## 9. 拘束条件 (Constraints / Joints)

### 9.1 拘束とは何か

**拘束(Constraint):** 2つの剛体間の相対位置・相対速度を特定の関係に保つ仕組み。  
毎フレーム、条件を満たすようにインパルスを計算して速度に加える。

**拘束関数 C:**  
「満たしたい条件」を式で表したもの。`C = 0` が理想状態。  
例: ボールジョイントのアンカー一致条件: `C = posB_anchor - posA_anchor = (0,0,0)`

**速度レベルの拘束:**  
C を時間微分して速度の条件式にする: `J · v + b = 0`  
- `J` : ヤコビアン行列(C を速度で微分したもの。「速度がどう動けば C が変化するか」を表す)
- `v` : 速度状態ベクトル `[linearVel_A, angularVel_A, linearVel_B, angularVel_B]`
- `b` : バイアス項(Baumgarte 補正や目標速度など)

---

### 9.2 PGS ソルバー

**目的:** 複数の拘束を同時に満たすインパルスを求める。  
**方法:** 各拘束を1つずつ順番に解き、それを複数回繰り返す(イテレーション法)。

**各拘束を1回解く手順:**

まず「現在の速度でこの拘束がどれだけ違反しているか」を求める。  
次に「違反をゼロにするのに必要なインパルス量 Δλ」を計算する。  
そのインパルスをクランプ(物理的に意味のある範囲に制限)してから速度に適用する。

```
// 事前計算: 有効質量(インパルスに対する速度変化の係数の逆数)
effectiveMass = J · M_inv · Jᵀ
// M_inv: 質量行列の逆数(invMassA, I_world_inv_A, invMassB, I_world_inv_B のブロック対角)

// ウォームスタート: 前フレームのインパルスを初期適用
warmStart(all_constraints)

// メインイテレーション
for iteration in 0..VELOCITY_ITERATIONS:
    for each constraint c:
        // 現在の拘束違反速度を計算
        v_rel = J · velocityState

        // 修正インパルスの計算
        Δλ = -(v_rel + bias) / effectiveMass
        // bias: Baumgarte 補正 = β/dt · C_measured

        // 累積インパルスのクランプ(射影)
        λ_prev = c.lambda
        c.lambda = clamp(c.lambda + Δλ,  lambda_min,  lambda_max)
        Δλ_actual = c.lambda - λ_prev

        // 速度状態を更新
        velocityState += M_inv · Jᵀ · Δλ_actual
```

**クランプ範囲の意味:**
```
接触法線: lambda_min = 0,       lambda_max = +∞    (押すだけ、引き戻さない)
摩擦    : lambda_min = -μ·λ_n,  lambda_max = +μ·λ_n (法線力に比例した限界)
ジョイント: lambda_min = -∞,     lambda_max = +∞    (制限なし)
```

---

### 9.3 Baumgarte スタビライゼーション

**問題:** 速度レベルの拘束だけでは位置誤差(ドリフト)が少しずつ蓄積していく。  
例: ボールジョイントの2点が少しずつ離れていく。

**解決:** バイアス項 `bias` に位置誤差を組み込み、速度修正と同時に位置ドリフトも補正する。  
具体的には「現在の位置誤差 C を dt で割って、修正に必要な速度成分を求め、バイアスに加える」。

```
bias = β/dt · C_measured
  β         : Baumgarte 係数。0.1〜0.2 が典型値
  dt        : タイムステップ
  C_measured: 現在の位置誤差の大きさ
```

β が大きすぎるとオーバーシュートして振動する。  
接触のめり込み修正は「逐次位置修正(§10)」で行い、Baumgarte はジョイントのドリフト補正に小さく使うのが安定。

---

### 9.4 ジョイントの種類

#### BallAndSocket (ボールジョイント)

位置を一致させるが回転は自由。肩・股関節など。

**拘束の意味:**  
A のアンカー点と B のアンカー点が常に同じワールド座標にあるべき、という3成分の位置拘束。

```
C_pos = (posB + R_B · r_localB) - (posA + R_A · r_localA) = 0  (3成分)
```

**ヤコビアン:**  
速度に関して C_pos を微分すると、線速度と角速度の係数が得られる。
```
J = [-I₃,  skew(R_A·r_localA),  I₃,  -skew(R_B·r_localB)]
// skew(v): ベクトル v の歪対称行列。skew(v)·u = cross(v, u) と等価
// skew((vx,vy,vz)) = [[ 0,-vz, vy], [ vz, 0,-vx], [-vy, vx, 0]]
```

---

#### Hinge (ヒンジジョイント)

1軸まわりの回転のみ許可。ドア・ひじ関節など。

**拘束の意味:**  
BallAndSocket の3成分の位置拘束に加え、さらに「ヒンジ軸に垂直な2軸まわりの回転を禁止する」2成分の回転拘束を追加する。  
ヒンジ軸 a に直交する2つのベクトル b, c を用意し、「B のヒンジ軸が b 方向にも c 方向にも向かない」ように拘束する。

```
// 位置拘束 (3成分): BallAndSocket と同様

// 回転拘束 (2成分):
C_rot1 = dot(R_B · a_B_local, b) = 0   // b 方向への向きを禁止
C_rot2 = dot(R_B · a_B_local, c) = 0   // c 方向への向きを禁止
```

---

#### Slider (スライダー)

1軸方向の移動のみ許可、回転は固定。ピストン・レールなど。

**拘束の意味:**  
スライド軸以外の2方向への移動(2成分)と、全回転(3成分)を拘束する。合計5成分。

---

#### Fixed (固定ジョイント)

全6自由度を拘束。溶接・親子関係など。

**拘束の意味:**  
3成分の位置拘束 + 3成分の回転拘束。相対姿勢を固定する回転拘束はクォータニオンのベクトル部から求める。

---

#### Distance (距離拘束)

2点間の距離を一定に保つ。伸びないロープなど。

**拘束の意味:**  
2点間の距離が rest_length に等しいというスカラー1成分の拘束。

```
C = |posB_anchor - posA_anchor| - rest_length = 0
```

ロープとして使う場合(引っ張りのみ): `lambda_min = 0`  
剛なロッドとして使う場合: `lambda_min = -∞`

---

## 10. めり込み解決

### 10.1 問題の背景

インパルスベースの衝突応答は「速度」を修正するが、「位置」は直接修正しない。  
1フレームで大きくめり込んでしまった場合、速度修正だけでは回復が遅く、物体が沈み込んで見える。

---

### 10.2 逐次位置修正の概念

速度ループとは**別に**、位置レベルで直接修正する追加ループ。  
「2つの物体が法線方向に、質量比に応じた量だけ互いに離れるよう、位置を直接移動させる」。  
速度には一切触れない。

**SLOP を設ける理由:**  
めり込みゼロを完全に維持しようとすると、浮動小数点誤差で次フレームに「わずかに飛び出した」と判断され、  
引き戻しと飛び出しを繰り返す数値振動が起きる。わずかなめり込み(例: 5mm)を許容することで安定する。

**PERCENT を 1.0 未満にする理由:**  
100%修正しようとすると、次フレームで相手が別の力で動いているため、  
修正が「行き過ぎ」になるオーバーシュートが起きる。80%程度に抑えることで安定する。

```
SLOP    = 0.005 [m]
PERCENT = 0.8

for iter in 0..POSITION_ITERATIONS:
    for each manifold (bodyA, bodyB, normal, penetration):

        actual_pen = max(0, penetration - SLOP)
        if actual_pen == 0: continue

        invMassSum = bodyA.invMass + bodyB.invMass
        if invMassSum < 1e-10: continue

        // 修正スカラー: 貫通量に比例し、質量の合計で正規化
        corr = actual_pen · PERCENT / invMassSum

        // 法線方向に、自分の invMass 比だけ動かす
        posA -= normal · corr · bodyA.invMass
        posB += normal · corr · bodyB.invMass

        // 姿勢修正(接触点まわりの微小回転)
        δθ_A = bodyA.I_world_inv · cross(r_A, -normal · corr · bodyA.invMass)
        δθ_B = bodyB.I_world_inv · cross(r_B,  normal · corr · bodyB.invMass)
        bodyA.orientation = normalize(bodyA.orientation
                              + 0.5 · Quaternion(0, δθ_A) * bodyA.orientation)
        bodyB.orientation = normalize(bodyB.orientation
                              + 0.5 · Quaternion(0, δθ_B) * bodyB.orientation)
```

---

### 10.3 SpeculativeContact (予測接触) と CCD

**問題:** 高速移動物体が1フレームで薄い壁をすり抜ける(Tunneling)。

**対策1 - スウェプト AABB:**  
現フレームと次フレームの推定位置の両方の AABB を包む大きな AABB でブロードフェーズを行う。  
これによりすり抜けを「候補ペア」として拾える。

```
next_pos  = body.position + body.linearVel · dt
next_aabb = computeAABB(body, next_pos)
swept.min = componentMin(current_aabb.min, next_aabb.min)
swept.max = componentMax(current_aabb.max, next_aabb.max)
```

**対策2 - CCD:** → §12 参照

---

## 11. Island システム

### 11.1 Island とは何か

**定義:** 接触またはジョイントで繋がっている物体のグループ。  
例: 床の上に積み重なった10個の箱 → 全体が1つの Island を形成する。

**なぜ必要か:**  
- Island 全体が静止していれば全体をスリープさせて計算をスキップできる
- Island 単位で並列処理できる(スレッド分割)
- スリープ起床をグループ単位で正確に管理できる

---

### 11.2 Island の構築手順

接触グラフを構築し、BFS/DFS で連結成分を見つける。

**手順の概念:**  
1. 全 DYNAMIC 物体を「未訪問」としてマーク
2. 未訪問の物体を1つ選び、BFS のキューに入れる
3. キューから物体を取り出し、その物体に接触またはジョイントで繋がっている物体を全てキューに追加する
4. STATIC 物体は Island に含めない(動かないが接触は Island のmanifold に入れる)
5. キューが空になったら1つの Island が完成
6. まだ未訪問の物体があれば 2 に戻る

```
function buildIslands(bodies, manifolds, joints) → Island[]:
    visited = {}
    islands = []

    for each body in bodies where body.bodyType == DYNAMIC AND body.isAwake:
        if body in visited: continue

        island = new Island
        queue  = [body]

        while queue not empty:
            current = queue.pop()
            if current in visited: continue
            visited.add(current)
            island.bodies.add(current)

            for each manifold m involving current:
                island.manifolds.add(m)
                other = m.otherBody(current)
                if other.bodyType == DYNAMIC AND other not in visited:
                    if other.isAwake:
                        // 起きている物体が隣接 → current も起こす効果
                        pass
                    queue.push(other)

            for each joint j involving current:
                island.joints.add(j)
                other = j.otherBody(current)
                if other.bodyType == DYNAMIC AND other not in visited:
                    queue.push(other)

        islands.append(island)
    return islands
```

---

### 11.3 Island 単位のスリープ管理

Island 内の全物体が静止しているかを確認し、全員静止なら Island ごとスリープする。  
逆に Island 内の1つでも起きていれば、他の静止物体も全て起こす(動かされる可能性があるため)。

```
function processIsland(island):
    all_still = all(body.sleepTimer >= SLEEP_TIME for body in island.bodies)

    if all_still:
        for body in island.bodies:
            body.isAwake = false
        return   // この Island のシミュレーションをスキップ

    // 一部でも起きている → 全体を起こす
    for body in island.bodies:
        if not body.isAwake:
            body.isAwake = true
            body.sleepTimer = 0

    simulateIsland(island)
```

---

## 12. CCD (連続衝突検出)

### 12.1 なぜ CCD が必要か

離散シミュレーション(フレームごとに位置をジャンプ)では、  
高速移動物体が1フレームで薄い壁をすり抜けることがある。  
CCD はフレーム間の軌跡全体を考慮して衝突を検出する。

---

### 12.2 Conservative Advancement (保守的前進法)

精度・速度のバランスが良い CCD の一般的な実装。

**基本アイデア:**  
「今の距離では少なくとも dist/rel_speed 秒間は衝突しない」という保守的な見積もりを使い、  
時刻パラメータ t を少しずつ進めていく。dist がゼロに近づいたら衝突。

**手順:**  
1. 時刻 t=0(フレーム開始)から始める  
2. 現在の t での位置で GJK を実行し、2形状の距離を得る  
3. 距離が閾値以下なら衝突確定 → t を返す  
4. 「現在の距離 / 相対速度の上限」を次のステップ幅 Δt とする  
   (これ以上動いても絶対に交差しない安全な時間量)  
5. t += Δt して 2 に戻る  
6. t が 1.0 に達したら今フレームでは衝突なし

```
function CCD_ConservativeAdvancement(bodyA, bodyB, dt) → float t_hit:
    t = 0.0
    for _ in 0..64:
        result = GJK(bodyA_at(t), bodyB_at(t))
        if result.intersecting OR result.distance < 0.001:
            return t   // 衝突時刻

        rel_speed = length(bodyA.linearVel - bodyB.linearVel)
                  + length(bodyA.angularVel) · bodyA.boundingRadius
                  + length(bodyB.angularVel) · bodyB.boundingRadius
        if rel_speed < 1e-6: return 1.0

        dt_step = result.distance / rel_speed
        t = min(t + dt_step, 1.0)
        if t >= 1.0: return 1.0

    return 1.0
```

---

### 12.3 CCD の適用対象

CCD は計算コストが高いため、必要な物体にだけ適用する。

```
// 1フレームで自分のサイズ以上動く場合に CCD 有効
function needsCCD(body) → bool:
    return length(body.linearVel) · dt > body.boundingRadius · 0.5
```

---

## 13. メインループ

### 13.1 固定タイムステップ

フレームレートが変化すると dt が変わり、物理挙動が変わる。固定 dt で再現性・安定性を確保する。

```
FIXED_DT  = 1.0 / 60   // 60Hz 固定
MAX_STEPS = 5           // 1フレームの最大ステップ数(急激なスパイク対策)
accumulator = 0.0

function gameLoop(frame_dt):
    accumulator += min(frame_dt, MAX_STEPS · FIXED_DT)
    while accumulator >= FIXED_DT:
        physicsStep(FIXED_DT)
        accumulator -= FIXED_DT
    alpha = accumulator / FIXED_DT   // 描画補間率 [0, 1)
    renderInterpolated(alpha)
```

---

### 13.2 physicsStep の全詳細フロー

```
function physicsStep(dt):

  ┌─────────────────────────────────────────────────────────────┐
  │ Phase 1: 外力の適用                                          │
  │ 入力: 重力設定、ゲームロジックからの addForce() 呼び出し        │
  │ 出力: 各 body の forceAccum, torqueAccum に力が蓄積される     │
  │ 理由: 積分前に全ての力を確定させるため                         │
  └─────────────────────────────────────────────────────────────┘
    for each DYNAMIC body that isAwake:
        body.forceAccum += GRAVITY · body.mass
        // ユーザーの addForce() は事前に呼ばれており forceAccum に積算済み

  ┌─────────────────────────────────────────────────────────────┐
  │ Phase 2: AABB の更新                                         │
  │ 入力: 各 body の現在の position, orientation                 │
  │ 出力: 各コライダーの AABB が現在位置で更新される               │
  │ 理由: ブロードフェーズが最新の位置情報を使うため               │
  └─────────────────────────────────────────────────────────────┘
    for each body that isAwake:
        for each collider:
            collider.aabb = computeAABB(collider, body)

  ┌─────────────────────────────────────────────────────────────┐
  │ Phase 3: ブロードフェーズ                                    │
  │ 入力: 全コライダーの AABB                                    │
  │ 出力: AABB が重なっているコライダーペアのリスト               │
  │ 理由: ナローフェーズに渡す候補を絞り込んで計算量を削減する     │
  └─────────────────────────────────────────────────────────────┘
    candidate_pairs = broadphase.query()
    // STATIC vs STATIC はスキップ
    // 両方スリープのペアもスキップ

  ┌─────────────────────────────────────────────────────────────┐
  │ Phase 4: ナローフェーズ                                      │
  │ 入力: candidate_pairs                                        │
  │ 出力: 実際に交差しているペアの ContactManifold リスト         │
  │ 理由: 正確な衝突情報(法線・貫通深度・接触点)を取得するため    │
  └─────────────────────────────────────────────────────────────┘
    manifolds = []
    for (collA, collB) in candidate_pairs:
        result = narrowphase(collA, collB)   // 解析的 or GJK+EPA
        if result.intersecting:
            m = buildOrUpdateManifold(collA.body, collB.body, result)
            // 前フレームの manifold があればインパルスキャッシュを引き継ぐ
            manifolds.append(m)

  ┌─────────────────────────────────────────────────────────────┐
  │ Phase 5: CCD (高速物体のみ)                                  │
  │ 入力: needsCCD() が true の物体のペア                        │
  │ 出力: 衝突時刻 t_hit と追加の ContactManifold               │
  │ 理由: 離散判定でのすり抜けを防ぐため                          │
  └─────────────────────────────────────────────────────────────┘
    for (bodyA, bodyB) in ccd_candidates:
        t_hit = CCD_ConservativeAdvancement(bodyA, bodyB, dt)
        if t_hit < 1.0:
            advanceTo(bodyA, t_hit · dt)
            advanceTo(bodyB, t_hit · dt)
            // 衝突応答して残り(1-t_hit)·dt を積分

  ┌─────────────────────────────────────────────────────────────┐
  │ Phase 6: Island の構築                                       │
  │ 入力: 全 body, manifolds, joints                             │
  │ 出力: Island[] (接触グラフの連結成分)                         │
  │ 理由: スリープ管理と並列化のためグループ化する                 │
  └─────────────────────────────────────────────────────────────┘
    islands = buildIslands(bodies, manifolds, joints)

  ┌─────────────────────────────────────────────────────────────┐
  │ Phase 7: 速度の積分                                          │
  │ 入力: forceAccum, torqueAccum, 現在の速度                    │
  │ 出力: 外力・重力を加算した暫定速度(拘束適用前)               │
  │ 理由: 拘束ソルバーはこの暫定速度を出発点として修正する        │
  └─────────────────────────────────────────────────────────────┘
    for each island not all-sleeping:
        for each DYNAMIC body in island:
            integrateVelocities(body, dt)   // §4.2

  ┌─────────────────────────────────────────────────────────────┐
  │ Phase 8: 拘束ソルバー(速度レベル)                            │
  │ 入力: manifolds, joints, 現在の速度                          │
  │ 出力: 接触・ジョイント拘束を満たした速度                      │
  │ 理由: 衝突応答とジョイント拘束をインパルスで解決する          │
  └─────────────────────────────────────────────────────────────┘
    for each island not all-sleeping:
        for each manifold: warmStart(manifold)
        for iter in 0..VELOCITY_ITERATIONS:
            for each manifold:
                for each contact: solveNormal(); solveFriction()
            for each joint: solveJoint(dt)

  ┌─────────────────────────────────────────────────────────────┐
  │ Phase 9: 位置の積分                                          │
  │ 入力: Phase 8 で修正された速度                               │
  │ 出力: 次フレームの position, orientation                     │
  │ 理由: 修正済み速度で位置を更新することで拘束が反映される      │
  └─────────────────────────────────────────────────────────────┘
    for each DYNAMIC/KINEMATIC body that isAwake:
        body.position    += body.linearVel · dt
        ω_q               = Quaternion(0, body.angularVel)
        body.orientation += 0.5 · (ω_q * body.orientation) · dt
        body.orientation  = normalize(body.orientation)

  ┌─────────────────────────────────────────────────────────────┐
  │ Phase 10: 位置修正(Penetration Correction)                   │
  │ 入力: manifolds の penetration, 現在の position/orientation  │
  │ 出力: めり込みを減らすよう直接修正された位置・姿勢            │
  │ 理由: 速度修正だけでは既存のめり込みが残るため               │
  └─────────────────────────────────────────────────────────────┘
    for iter in 0..POSITION_ITERATIONS:
        for each manifold:
            positionalCorrection(manifold)   // §10.2

  ┌─────────────────────────────────────────────────────────────┐
  │ Phase 11: スリープ更新                                        │
  │ 入力: 各 body の速度, sleepTimer                             │
  │ 出力: isAwake フラグの更新                                   │
  │ 理由: 静止物体を次フレームのシミュレーションから除外する       │
  └─────────────────────────────────────────────────────────────┘
    for each island:
        updateIslandSleep(island, dt)
```

---

## 14. パラメータ設計指針

### 14.1 全パラメータ一覧

| パラメータ | 推奨値 | 説明 | 大きくすると | 小さくすると |
|-----------|--------|------|------------|------------|
| `FIXED_DT` | 1/60 s | シミュレーションのタイムステップ | 精度↓ 速度↑ | 精度↑ 速度↓ |
| `GRAVITY` | (0,−9.8,0) | 重力加速度 [m/s²] | 速く落ちる | 浮く感じ |
| `VELOCITY_ITERATIONS` | 10〜20 | 速度拘束の反復回数 | 安定↑ 重い | 振動・貫通 |
| `POSITION_ITERATIONS` | 3〜5 | 位置修正の反復回数 | 誤差少ない | めり込み残る |
| `SLOP` | 0.005 m | 許容めり込み量 | 沈み込み目立つ | 振動しやすい |
| `PERCENT` | 0.8 | 位置修正の割合/ステップ | オーバーシュート | 収束が遅い |
| `linearDamping` | 0.01 | 線速度の減衰 | すぐ止まる | 永遠に動く |
| `angularDamping` | 0.05 | 角速度の減衰 | すぐ止まる | ずっと回る |
| `restitution` | 0〜0.5 | 反発係数 | よく弾む | 弾まない |
| `friction` | 0.3〜0.8 | 摩擦係数 | 滑りにくい | よく滑る |
| `baumgarte β` | 0.1〜0.2 | ジョイントドリフト補正率 | 振動しやすい | 誤差蓄積 |
| `SLEEP_THRESHOLD_LIN` | 0.05 m/s | スリープ判定の線速度閾値 | すぐスリープ | スリープしない |
| `SLEEP_THRESHOLD_ANG` | 0.05 rad/s | スリープ判定の角速度閾値 | すぐスリープ | スリープしない |
| `SLEEP_TIME` | 0.5 s | スリープまでの静止時間 | 遅延が大きい | 誤スリープ |
| `EPA_TOLERANCE` | 0.001 m | EPA の収束閾値 | 精度低い・速い | 精度高い・遅い |
| `CCD_THRESHOLD` | 0.5 | CCD 有効化の速度閾値(boundingRadius 比) | 少ない物体でCCD | 多くの物体でCCD |

---

### 14.2 素材パラメータの例

| 素材 | restitution | friction |
|------|------------|---------|
| ゴム | 0.8 | 0.8 |
| 木材 | 0.2 | 0.5 |
| 金属 | 0.3 | 0.3 |
| 氷 | 0.1 | 0.05 |
| 石 | 0.1 | 0.7 |
| ガラス | 0.5 | 0.4 |

---

### 14.3 実装順序ロードマップ

```
Step 1 — 数学基盤
  □ Vec3, Quaternion, Mat3x3 の演算クラス
  □ ユニットテスト(内積・外積・クォータニオン積・回転行列)

Step 2 — 基本シミュレーション
  □ RigidBody 構造体
  □ 半陰的オイラー積分 + 重力
  □ 確認: 球が落ちていく

Step 3 — Sphere vs Sphere (解析的)
  □ 交差判定 + インパルス応答
  □ 確認: 2球が正しく弾き合う

Step 4 — Plane vs Sphere
  □ Plane コライダー + 解析的判定
  □ 確認: 球を落として床で弾む

Step 5 — ブロードフェーズ
  □ AABB 生成 + 重なり判定(総当り)

Step 6 — 摩擦
  □ 接線インパルス + クーロンクランプ
  □ 確認: 球を斜面に置いて滑る/止まる

Step 7 — 位置修正
  □ SLOP + PERCENT の逐次位置修正
  □ 確認: 重ねた球が沈み込まない

Step 8 — Box コライダー
  □ Box vs Plane(頂点-平面), Box vs Sphere(最近傍点)
  □ クリッピング法によるコンタクトマニフォールド

Step 9 — GJK + EPA
  □ doSimplex の3ケース実装
  □ EPA のポリトープ拡張
  □ Box vs Box, Box vs Polyhedron

Step 10 — スリープ + Island
  □ sleepTimer の更新
  □ 接触グラフ BFS で Island 構築

Step 11 — ジョイント
  □ PGS ソルバー(拘束クラス)
  □ BallAndSocket → Hinge の順で実装

Step 12 — Capsule
  □ 線分-点・線分-線分の最近傍計算
  □ Capsule vs Sphere, Capsule vs Plane, Capsule vs Box

Step 13 — CCD
  □ Conservative Advancement
  □ 確認: 高速な薄い物体がすり抜けない

Step 14 — 最適化
  □ Sort & Sweep ブロードフェーズ
  □ ウォームスタートの精度向上
  □ Island 並列処理
```
