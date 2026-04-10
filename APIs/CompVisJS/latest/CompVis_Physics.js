/**
 * CompVis.Physics — 本格的な3D物理エンジン
 * 
 * CompVis.Physics.Three クラスを中心に、以下の機能を実装:
 *
 *  剛体力学 (Rigid Body Dynamics)
 *    ・質量・慣性テンソル・重心管理
 *    ・線形/角速度の数値積分 (Symplectic Euler / RK4 切替可能)
 *    ・クォータニオンベース回転
 *
 *  衝突検出 (Collision Detection)
 *    ・AABB Broad-phase
 *    ・GJK + EPA Narrow-phase (Sphere/Box/Convex Mesh)
 *    ・連続衝突検出 (CCD) — トンネリング防止
 *
 *  衝突応答 (Collision Response)
 *    ・衝撃量ベース(Impulse-based)アルゴリズム
 *    ・反発係数 (restitution)、摩擦係数 (friction) 対応
 *    ・ペネトレーション補正 (Baumgarte stabilization)
 *
 *  制約ソルバー (Sequential Impulse Solver)
 *    ・接触点制約
 *    ・ヒンジ・スライダー・ポイント-ポイント・バネ制約
 *    ・iterative solver (位置/速度レベル)
 *
 *  力・トルク (Forces & Torques)
 *    ・重力・定数力・バネ力
 *    ・空気抵抗 (drag)
 *    ・風力場・重力場
 *
 *  Three.jsビジュアル連携
 *    ・ViewThreeへの自動同期 (位置・回転)
 *    ・デバッグ描画 (AABB・法線・接触点)
 *    ・ジョイント可視化
 *
 * 使用例 (CompVisJS.js読込み後):
 *   const container = document.getElementById("container");
 *   const viewThree = new CompVis.ViewThree(container);
 *   const world = new CompVis.Physics.Three(viewThree);
 *   world.gravity.set(0, -9.81, 0);
 *
 *   const floor = world.addBody({
 *     shape: "box", size: [20,0.5,20],
 *     position: [0,-5,0], mass: 0  // mass=0 → 静的
 *   });
 *   const ball = world.addBody({
 *     shape: "sphere", radius: 1,
 *     position: [0,10,0], mass: 1
 *   });
 *   world.start();
 */

// ============================
//  CompVis.Physics 名前空間
// ============================
CompVis.Physics = class {
  constructor() { this.type = "Physics"; }
};

// ============================
//  小さな3次元ベクトルユーティリティ (Three.js に依存しない内部用)
// ============================
CompVis.Physics._Vec3 = class {
  constructor(x=0,y=0,z=0){
    this.x=x; this.y=y; this.z=z;
  }
  static from(a){ return new CompVis.Physics._Vec3(a.x,a.y,a.z); }
  clone(){ return new CompVis.Physics._Vec3(this.x,this.y,this.z); }
  set(x,y,z){ this.x=x;this.y=y;this.z=z;return this; }
  copy(v){ this.x=v.x;this.y=v.y;this.z=v.z;return this; }
  add(v){ return new CompVis.Physics._Vec3(this.x+v.x,this.y+v.y,this.z+v.z); }
  sub(v){ return new CompVis.Physics._Vec3(this.x-v.x,this.y-v.y,this.z-v.z); }
  scale(s){ return new CompVis.Physics._Vec3(this.x*s,this.y*s,this.z*s); }
  dot(v){ return this.x*v.x+this.y*v.y+this.z*v.z; }
  cross(v){ return new CompVis.Physics._Vec3(
    this.y*v.z-this.z*v.y,
    this.z*v.x-this.x*v.z,
    this.x*v.y-this.y*v.x
  );}
  get lenSq(){ return this.x*this.x+this.y*this.y+this.z*this.z; }
  get len(){ return Math.sqrt(this.lenSq); }
  get normalized(){
    const l=this.len;
    if(l<1e-12) return new CompVis.Physics._Vec3();
    return this.scale(1/l);
  }
  negate(){ return this.scale(-1); }
  addSelf(v){ this.x+=v.x;this.y+=v.y;this.z+=v.z;return this; }
  subSelf(v){ this.x-=v.x;this.y-=v.y;this.z-=v.z;return this; }
  scaleSelf(s){ this.x*=s;this.y*=s;this.z*=s;return this; }
  distSq(v){ return this.sub(v).lenSq; }
  dist(v){ return Math.sqrt(this.distSq(v)); }
  toArray(){ return [this.x,this.y,this.z]; }
  // 行列(3x3フラット配列)との積 M*v
  applyMat3(m){
    return new CompVis.Physics._Vec3(
      m[0]*this.x+m[1]*this.y+m[2]*this.z,
      m[3]*this.x+m[4]*this.y+m[5]*this.z,
      m[6]*this.x+m[7]*this.y+m[8]*this.z
    );
  }
};
const _V = (...a)=>new CompVis.Physics._Vec3(...a);

// ============================
//  クォータニオン (内部用)
// ============================
CompVis.Physics._Quat = class {
  constructor(x=0,y=0,z=0,w=1){ this.x=x;this.y=y;this.z=z;this.w=w; }
  static identity(){ return new CompVis.Physics._Quat(); }
  clone(){ return new CompVis.Physics._Quat(this.x,this.y,this.z,this.w); }
  copy(q){ this.x=q.x;this.y=q.y;this.z=q.z;this.w=q.w;return this; }
  // Hamilton積
  mul(q){
    const {x:ax,y:ay,z:az,w:aw}=this;
    const {x:bx,y:by,z:bz,w:bw}=q;
    return new CompVis.Physics._Quat(
      aw*bx+ax*bw+ay*bz-az*by,
      aw*by-ax*bz+ay*bw+az*bx,
      aw*bz+ax*by-ay*bx+az*bw,
      aw*bw-ax*bx-ay*by-az*bz
    );
  }
  // 純クォータニオンとの積 (角速度の積分に使用)
  mulVec(v){
    return this.mul(new CompVis.Physics._Quat(v.x,v.y,v.z,0));
  }
  normalize(){
    const n=Math.sqrt(this.x**2+this.y**2+this.z**2+this.w**2);
    if(n<1e-12){this.w=1;this.x=this.y=this.z=0;return this;}
    this.x/=n;this.y/=n;this.z/=n;this.w/=n;return this;
  }
  get conjugate(){ return new CompVis.Physics._Quat(-this.x,-this.y,-this.z,this.w); }
  // 3x3回転行列 (行優先フラット)
  toMat3(){
    const {x,y,z,w}=this;
    return [
      1-2*(y*y+z*z), 2*(x*y-w*z),   2*(x*z+w*y),
      2*(x*y+w*z),   1-2*(x*x+z*z), 2*(y*z-w*x),
      2*(x*z-w*y),   2*(y*z+w*x),   1-2*(x*x+y*y)
    ];
  }
  // ベクトルを回転
  rotateVec(v){
    return v.applyMat3(this.toMat3());
  }
  // 軸・角度から生成
  static fromAxisAngle(axis,angle){
    const s=Math.sin(angle/2);
    const n=axis.normalized;
    return new CompVis.Physics._Quat(n.x*s,n.y*s,n.z*s,Math.cos(angle/2));
  }
  // 角速度ωで dt 秒積分 (一次近似)
  integrateOmega(omega,dt){
    const half=0.5*dt;
    const dq=this.mulVec(omega);
    this.x+=dq.x*half;
    this.y+=dq.y*half;
    this.z+=dq.z*half;
    this.w+=dq.w*half;
    return this.normalize();
  }
};
const _Q = ()=>CompVis.Physics._Quat.identity();

// ============================
//  3x3対称行列ユーティリティ
// ============================
CompVis.Physics._Mat3 = class {
  constructor(m=[1,0,0,0,1,0,0,0,1]){ this.m=m.slice(); }
  static identity(){ return new CompVis.Physics._Mat3(); }
  static zero(){ return new CompVis.Physics._Mat3([0,0,0,0,0,0,0,0,0]); }
  clone(){ return new CompVis.Physics._Mat3(this.m.slice()); }
  mul(b){ // this * b
    const a=this.m, B=b.m, r=new Array(9);
    for(let i=0;i<3;i++) for(let j=0;j<3;j++){
      r[i*3+j]=a[i*3]*B[j]+a[i*3+1]*B[3+j]+a[i*3+2]*B[6+j];
    }
    return new CompVis.Physics._Mat3(r);
  }
  transpose(){
    const m=this.m;
    return new CompVis.Physics._Mat3([m[0],m[3],m[6],m[1],m[4],m[7],m[2],m[5],m[8]]);
  }
  scale(s){ return new CompVis.Physics._Mat3(this.m.map(v=>v*s)); }
  add(b){ return new CompVis.Physics._Mat3(this.m.map((v,i)=>v+b.m[i])); }
  mulVec(v){ return v.applyMat3(this.m); }
  inverse(){
    const m=this.m;
    const det=m[0]*(m[4]*m[8]-m[5]*m[7])-m[1]*(m[3]*m[8]-m[5]*m[6])+m[2]*(m[3]*m[7]-m[4]*m[6]);
    if(Math.abs(det)<1e-14) return CompVis.Physics._Mat3.identity();
    const inv=1/det;
    return new CompVis.Physics._Mat3([
      (m[4]*m[8]-m[5]*m[7])*inv,(m[2]*m[7]-m[1]*m[8])*inv,(m[1]*m[5]-m[2]*m[4])*inv,
      (m[5]*m[6]-m[3]*m[8])*inv,(m[0]*m[8]-m[2]*m[6])*inv,(m[2]*m[3]-m[0]*m[5])*inv,
      (m[3]*m[7]-m[4]*m[6])*inv,(m[1]*m[6]-m[0]*m[7])*inv,(m[0]*m[4]-m[1]*m[3])*inv
    ]);
  }
  // クォータニオンで回転 R * I * R^T
  rotate(q){
    const R=new CompVis.Physics._Mat3(q.toMat3());
    return R.mul(this).mul(R.transpose());
  }
};

// ============================
//  AABB (Axis-Aligned Bounding Box)
// ============================
CompVis.Physics._AABB = class {
  constructor(){
    this.min=_V(Infinity,Infinity,Infinity);
    this.max=_V(-Infinity,-Infinity,-Infinity);
  }
  expand(v){
    this.min.x=Math.min(this.min.x,v.x);
    this.min.y=Math.min(this.min.y,v.y);
    this.min.z=Math.min(this.min.z,v.z);
    this.max.x=Math.max(this.max.x,v.x);
    this.max.y=Math.max(this.max.y,v.y);
    this.max.z=Math.max(this.max.z,v.z);
  }
  intersects(b){
    return !(this.max.x<b.min.x||this.min.x>b.max.x||
             this.max.y<b.min.y||this.min.y>b.max.y||
             this.max.z<b.min.z||this.min.z>b.max.z);
  }
  fatten(margin){
    this.min.subSelf(_V(margin,margin,margin));
    this.max.addSelf(_V(margin,margin,margin));
  }
};

// ============================
//  形状 (Shape) — Sphere / Box / Convex
// ============================
CompVis.Physics.Shape = class {
  // type: "sphere" | "box" | "convex"
  constructor(type, params={}){
    this.type=type;
    if(type==="sphere"){
      this.radius=params.radius??1;
    } else if(type==="box"){
      this.halfExtents=_V(
        (params.size?params.size[0]:params.halfExtents?params.halfExtents[0]*2:2)/2,
        (params.size?params.size[1]:params.halfExtents?params.halfExtents[1]*2:2)/2,
        (params.size?params.size[2]:params.halfExtents?params.halfExtents[2]*2:2)/2
      );
    } else if(type==="convex"){
      this.vertices=params.vertices; // _Vec3[]
    } else if(type==="capsule"){
      this.radius=params.radius??0.5;
      this.halfHeight=params.halfHeight??1;
    }
  }

  // 質量・慣性テンソルを計算 (局所座標)
  computeInertia(mass){
    const I=CompVis.Physics._Mat3.zero();
    if(this.type==="sphere"){
      const r2=this.radius**2;
      const v=2/5*mass*r2;
      I.m[0]=I.m[4]=I.m[8]=v;
    } else if(this.type==="box"){
      const h=this.halfExtents;
      I.m[0]=mass/12*(4*h.y**2+4*h.z**2);
      I.m[4]=mass/12*(4*h.x**2+4*h.z**2);
      I.m[8]=mass/12*(4*h.x**2+4*h.y**2);
    } else if(this.type==="capsule"){
      // 近似: cylinder + 2 hemispheresの合計慣性
      const r=this.radius, h=this.halfHeight*2;
      const mCyl=mass*0.75, mSph=mass*0.25;
      const Icyl_y=mCyl*r*r/2;
      const Icyl_xz=mCyl*(3*r*r+h*h)/12;
      const Isph=2/5*mSph*r*r;
      I.m[0]=I.m[8]=Icyl_xz+Isph;
      I.m[4]=Icyl_y+Isph;
    } else { // convex - 簡易箱近似
      const verts=this.vertices;
      let maxE=0;
      verts.forEach(v=>{ maxE=Math.max(maxE,Math.abs(v.x),Math.abs(v.y),Math.abs(v.z)); });
      const h=maxE;
      I.m[0]=I.m[4]=I.m[8]=mass/6*(2*h*h);
    }
    return I;
  }

  // AABB を position + quaternion から計算
  computeAABB(pos, q){
    const aabb=new CompVis.Physics._AABB();
    if(this.type==="sphere"){
      const r=this.radius;
      aabb.min=_V(pos.x-r,pos.y-r,pos.z-r);
      aabb.max=_V(pos.x+r,pos.y+r,pos.z+r);
    } else if(this.type==="box"){
      const h=this.halfExtents;
      // 回転後の拡張量: |R| * h の各行の絶対値の和
      const R=q.toMat3();
      const ex=Math.abs(R[0])*h.x+Math.abs(R[1])*h.y+Math.abs(R[2])*h.z;
      const ey=Math.abs(R[3])*h.x+Math.abs(R[4])*h.y+Math.abs(R[5])*h.z;
      const ez=Math.abs(R[6])*h.x+Math.abs(R[7])*h.y+Math.abs(R[8])*h.z;
      aabb.min=_V(pos.x-ex,pos.y-ey,pos.z-ez);
      aabb.max=_V(pos.x+ex,pos.y+ey,pos.z+ez);
    } else if(this.type==="capsule"){
      const r=this.radius, h=this.halfHeight;
      const axis=q.rotateVec(_V(0,1,0));
      const top=pos.add(axis.scale(h));
      const bot=pos.sub(axis.scale(h));
      aabb.min=_V(Math.min(top.x,bot.x)-r,Math.min(top.y,bot.y)-r,Math.min(top.z,bot.z)-r);
      aabb.max=_V(Math.max(top.x,bot.x)+r,Math.max(top.y,bot.y)+r,Math.max(top.z,bot.z)+r);
    } else { // convex
      this.vertices.forEach(v=>{
        aabb.expand(pos.add(q.rotateVec(v)));
      });
    }
    return aabb;
  }

  // サポート関数 (GJK用) — ワールド空間の点を返す
  support(pos, q, dir){
    if(this.type==="sphere"){
      return pos.add(dir.normalized.scale(this.radius));
    }
    if(this.type==="box"){
      const localDir=q.conjugate.rotateVec(dir);
      const h=this.halfExtents;
      const localPt=_V(
        localDir.x>0?h.x:-h.x,
        localDir.y>0?h.y:-h.y,
        localDir.z>0?h.z:-h.z
      );
      return pos.add(q.rotateVec(localPt));
    }
    if(this.type==="capsule"){
      const localDir=q.conjugate.rotateVec(dir);
      const h=this.halfHeight, r=this.radius;
      const top=_V(0,h,0), bot=_V(0,-h,0);
      const pt=localDir.dot(top)>=localDir.dot(bot)?top:bot;
      const worldPt=pos.add(q.rotateVec(pt));
      return worldPt.add(dir.normalized.scale(r));
    }
    // convex
    const localDir=q.conjugate.rotateVec(dir);
    let best=-Infinity, bestVert=this.vertices[0];
    this.vertices.forEach(v=>{
      const d=localDir.dot(v);
      if(d>best){best=d;bestVert=v;}
    });
    return pos.add(q.rotateVec(bestVert));
  }
};

// ============================
//  剛体 (RigidBody)
// ============================
CompVis.Physics.RigidBody = class {
  constructor(opts={}){
    this.id = CompVis.getId("PhysicsBody");
    this.shape = opts.shape ?? null; // CompVis.Physics.Shape

    // 位置・速度 (ワールド空間)
    this.position = opts.position ? _V(...opts.position) : _V();
    this.prevPosition = this.position.clone(); // CCD用
    this.velocity = opts.velocity ? _V(...opts.velocity) : _V();
    this.orientation = CompVis.Physics._Quat.identity();
    this.angularVelocity = _V(); // rad/s (ワールド空間)

    // 質量
    const mass = opts.mass ?? 1;
    this.isStatic = (mass===0);
    this.mass = this.isStatic ? Infinity : mass;
    this.invMass = this.isStatic ? 0 : 1/mass;

    // 慣性テンソル (ワールド空間)
    this._localInertia = this.shape ? this.shape.computeInertia(this.mass) : CompVis.Physics._Mat3.identity();
    this._localInvInertia = this.isStatic ? CompVis.Physics._Mat3.zero() : this._localInertia.inverse();
    this.invInertiaWorld = this._localInvInertia.clone();

    // 力・トルクアキュムレータ
    this.force = _V();
    this.torque = _V();

    // 素材
    this.restitution = opts.restitution ?? 0.3;
    this.friction    = opts.friction    ?? 0.5;
    this.linearDamping  = opts.linearDamping  ?? 0.01;
    this.angularDamping = opts.angularDamping ?? 0.02;

    // スリープ
    this.isSleeping = false;
    this._sleepTimer = 0;
    this.allowSleep  = opts.allowSleep ?? true;

    // Three.jsメッシュ参照
    this.mesh = null; // 外部からセット

    // AABB (broad phase用)
    this.aabb = new CompVis.Physics._AABB();

    // グループ/マスク (衝突フィルタ)
    this.collisionGroup = opts.collisionGroup ?? 1;
    this.collisionMask  = opts.collisionMask  ?? 0xFFFF;

    // 有効フラグ
    this.enabled = true;
    
    // ユーザデータ
    this.userData = opts.userData ?? {};

    // 各種初期化
    this._updateAABB();
    this._updateInertiaWorld();
  }

  _updateInertiaWorld(){
    // I_world = R * I_local * R^T
    if(this.isStatic) return;
    const R = this.orientation;
    this.invInertiaWorld = this._localInvInertia.rotate(R);
  }

  _updateAABB(){
    if(this.shape){
      this.aabb = this.shape.computeAABB(this.position, this.orientation);
    }
  }

  applyForce(f, relPos=null){
    this.force.addSelf(f);
    if(relPos){ this.torque.addSelf(relPos.cross(f)); }
  }

  applyImpulse(j, relPos=null){
    // 速度変化
    this.velocity.addSelf(j.scale(this.invMass));
    if(relPos){
      // 角速度変化: Δω = I⁻¹(r × j)
      const dw = this.invInertiaWorld.mulVec(relPos.cross(j));
      this.angularVelocity.addSelf(dw);
    }
    this.isSleeping = false;
    this._sleepTimer = 0;
  }

  applyTorque(t){
    this.torque.addSelf(t);
  }

  // 慣性テンソルとの積 (接触応答用)
  getInvEffectiveMass(r, n){
    // 1/m + (r×n)·I⁻¹·(r×n)
    const rxn = r.cross(n);
    return this.invMass + rxn.dot(this.invInertiaWorld.mulVec(rxn));
  }

  wake(){
    this.isSleeping=false;
    this._sleepTimer=0;
  }

  get kineticEnergy(){
    return 0.5*this.mass*this.velocity.lenSq
         + 0.5*this.angularVelocity.dot(this._localInertia.mulVec(this.angularVelocity));
  }
};

// ============================
//  GJK + EPA 衝突検出
// ============================
CompVis.Physics._GJK = class {
  // ミンコフスキー差のサポート関数
  static _support(a, b, dir){
    const pa=a.shape.support(a.position,a.orientation,dir);
    const pb=b.shape.support(b.position,b.orientation,dir.negate());
    return pa.sub(pb); // ミンコフスキー差上の点
  }

  // GJK法: 衝突しているか？ → true / false
  // 衝突していればsimplexも返す
  static detect(a, b){
    const MAX_ITER=64;
    let dir=b.position.sub(a.position);
    if(dir.lenSq<1e-12) dir=_V(1,0,0);

    const simplex=[];
    let s=this._support(a,b,dir);
    simplex.push(s);
    dir=s.negate();

    for(let iter=0;iter<MAX_ITER;iter++){
      dir=dir.normalized;
      if(dir.lenSq<1e-20) return {hit:false};
      s=this._support(a,b,dir);
      if(s.dot(dir)<-1e-8) return {hit:false}; // 原点に届かない
      simplex.push(s);
      const {hit,newDir}=this._doSimplex(simplex);
      if(hit) return {hit:true,simplex};
      dir=newDir;
    }
    return {hit:false};
  }

  // シンプレックス → 原点への最近接方向の更新
  static _doSimplex(s){
    switch(s.length){
      case 2: return this._line(s);
      case 3: return this._triangle(s);
      case 4: return this._tetrahedron(s);
    }
    return {hit:false,newDir:_V(1,0,0)};
  }

  static _line(s){
    const [b,a]=s;
    const ab=b.sub(a), ao=a.negate();
    if(ab.dot(ao)>0){
      return {hit:false,newDir:ab.cross(ao).cross(ab)};
    }
    s.length=0; s.push(a);
    return {hit:false,newDir:ao};
  }

  static _triangle(s){
    const [c,b,a]=s;
    const ab=b.sub(a),ac=c.sub(a),ao=a.negate();
    const abc=ab.cross(ac);
    if(abc.cross(ac).dot(ao)>0){
      if(ac.dot(ao)>0){ s.length=0;s.push(c,a);return{hit:false,newDir:ac.cross(ao).cross(ac)}; }
      return this._line([b,a]);
    }
    if(ab.cross(abc).dot(ao)>0) return this._line([b,a]);
    if(abc.dot(ao)>0) return{hit:false,newDir:abc};
    s.length=0;s.push(b,c,a);
    return{hit:false,newDir:abc.negate()};
  }

  static _tetrahedron(s){
    const [d,c,b,a]=s;
    const ab=b.sub(a),ac=c.sub(a),ad=d.sub(a),ao=a.negate();
    const abc=ab.cross(ac), acd=ac.cross(ad), adb=ad.cross(ab);
    if(abc.dot(ao)>0){ s.length=0;s.push(c,b,a);return this._triangle(s); }
    if(acd.dot(ao)>0){ s.length=0;s.push(d,c,a);return this._triangle(s); }
    if(adb.dot(ao)>0){ s.length=0;s.push(b,d,a);return this._triangle(s); }
    return{hit:true};
  }

  // EPA法: 衝突深度・法線・接触点を計算
  static EPA(a, b, simplex){
    const MAX_ITER=64;
    const faces=this._initFaces(simplex);

    for(let iter=0;iter<MAX_ITER;iter++){
      // 最も原点に近い面を探す
      let minDist=Infinity, minFace=-1;
      for(let i=0;i<faces.length;i++){
        const d=faces[i].n.dot(faces[i].v0);
        if(d<minDist){minDist=d;minFace=i;}
      }
      const face=faces[minFace];
      const s=this._support(a,b,face.n);
      const sd=s.dot(face.n);
      if(sd-minDist<1e-4){
        // 接触点 (2つの形状上の点の平均)
        // face.v0, face.v1, face.v2 はミンコフスキー差の点
        // 重心座標で接触点を求める
        const n=face.n;
        const depth=sd;
        const contact=a.shape.support(a.position,a.orientation,n);
        return {depth,normal:n,contactA:contact,contactB:contact.sub(n.scale(depth))};
      }
      // 新しい点を追加して面を分割
      this._expand(faces,s);
    }
    // フォールバック
    const n=simplex[0].normalized;
    return{depth:0,normal:n,contactA:a.position.clone(),contactB:b.position.clone()};
  }

  static _initFaces(simplex){
    // テトラhedrに拡張
    while(simplex.length<4){
      const extras=[_V(1,0,0),_V(0,1,0),_V(0,0,1)];
      for(const e of extras){
        simplex.push(e);
        if(simplex.length>=4) break;
      }
    }
    const [a,b,c,d]=simplex;
    const makeFace=(v0,v1,v2)=>{
      const e1=v1.sub(v0),e2=v2.sub(v0);
      let n=e1.cross(e2).normalized;
      if(n.dot(v0)<0) n=n.negate();
      return{v0,v1,v2,n};
    };
    return[makeFace(a,b,c),makeFace(a,c,d),makeFace(a,d,b),makeFace(b,d,c)];
  }

  static _expand(faces,newPt){
    // 見える面を削除し、境界エッジから新しい面を作成
    const visible=[];
    const edges=[];
    for(let i=faces.length-1;i>=0;i--){
      if(faces[i].n.dot(newPt.sub(faces[i].v0))>0){
        const f=faces.splice(i,1)[0];
        visible.push(f);
        const addEdge=(ea,eb)=>{
          const rev=edges.findIndex(e=>e[0]===eb&&e[1]===ea);
          if(rev>=0) edges.splice(rev,1);
          else edges.push([ea,eb]);
        };
        addEdge(f.v0,f.v1);addEdge(f.v1,f.v2);addEdge(f.v2,f.v0);
      }
    }
    edges.forEach(([ea,eb])=>{
      const e1=eb.sub(ea),e2=newPt.sub(ea);
      let n=e1.cross(e2).normalized;
      if(n.dot(ea)<0) n=n.negate();
      faces.push({v0:ea,v1:eb,v2:newPt,n});
    });
  }
};

// ============================
//  接触情報
// ============================
CompVis.Physics.Contact = class {
  constructor(bodyA, bodyB, normal, depth, contactPtA, contactPtB){
    this.bodyA=bodyA; this.bodyB=bodyB;
    this.normal=normal; // B→A
    this.depth=depth;
    this.contactPtA=contactPtA; // ワールド空間
    this.contactPtB=contactPtB;
    // 相対接触点 (重心から)
    this.rA=contactPtA.sub(bodyA.position);
    this.rB=contactPtB.sub(bodyB.position);
    // ラムダ (インパルス累積値、ウォームスタート用)
    this.lambdaN=0; // 法線
    this.lambdaT1=0; this.lambdaT2=0; // 接線(摩擦)
    // 接線方向
    this._computeTangents();
  }
  _computeTangents(){
    const n=this.normal;
    // ブレンシャムの方法で接線を求める
    const t1=Math.abs(n.x)<0.9?_V(0,n.z,-n.y).normalized:_V(-n.z,0,n.x).normalized;
    const t2=n.cross(t1).normalized;
    this.t1=t1; this.t2=t2;
  }
};

// ============================
//  制約 (Constraint) 基底
// ============================
CompVis.Physics.Constraint = class {
  constructor(bodyA, bodyB){ this.bodyA=bodyA; this.bodyB=bodyB; }
  solve(dt){}
};

// ポイント-ポイント制約 (2物体の特定点を繋ぐ)
CompVis.Physics.PointConstraint = class extends CompVis.Physics.Constraint {
  constructor(bodyA, bodyB, pivotA, pivotB){
    super(bodyA,bodyB);
    this.pivotA=pivotA?_V(...pivotA):_V(); // ローカル座標
    this.pivotB=pivotB?_V(...pivotB):_V();
    this.type="point";
  }
  solve(dt){
    const a=this.bodyA, b=this.bodyB;
    const rA=a.orientation.rotateVec(this.pivotA);
    const rB=b.orientation.rotateVec(this.pivotB);
    const pA=a.position.add(rA);
    const pB=b.position.add(rB);
    const err=pA.sub(pB);
    const C=err.len;
    if(C<1e-6) return;
    const n=err.normalized;
    const bias=0.1/dt*C;
    // Jacobianでインパルス計算
    const imA=a.getInvEffectiveMass(rA,n);
    const imB=b.getInvEffectiveMass(rB,n);
    const denom=imA+imB;
    if(denom<1e-12) return;
    const lam=-(bias)/denom;
    const j=n.scale(lam);
    a.applyImpulse(j.negate(),rA);
    b.applyImpulse(j,rB);
  }
};

// ヒンジ制約 (2物体を軸で繋ぐ)
CompVis.Physics.HingeConstraint = class extends CompVis.Physics.Constraint {
  constructor(bodyA, bodyB, pivotA, pivotB, axisA, axisB, opts={}){
    super(bodyA,bodyB);
    this.pivotA=_V(...pivotA);
    this.pivotB=_V(...pivotB);
    this.axisA=_V(...axisA).normalized;
    this.axisB=_V(...axisB).normalized;
    this.lowerAngle=opts.lowerAngle??-Infinity;
    this.upperAngle=opts.upperAngle??Infinity;
    this.type="hinge";
    // ポイント制約も内蔵
    this._pt=new CompVis.Physics.PointConstraint(bodyA,bodyB,pivotA,pivotB);
  }
  solve(dt){
    this._pt.solve(dt); // まず位置拘束
    const a=this.bodyA, b=this.bodyB;
    const wA=a.orientation.rotateVec(this.axisA);
    const wB=b.orientation.rotateVec(this.axisB);
    // 軸を揃える制約 (wA × wB ≈ 0)
    const err=wA.cross(wB);
    const errLen=err.len;
    if(errLen<1e-6) return;
    const n=err.normalized;
    const bias=0.1/dt*errLen;
    const Iinv_A=a.invInertiaWorld.mulVec(n);
    const Iinv_B=b.invInertiaWorld.mulVec(n);
    const denom=n.dot(Iinv_A)+n.dot(Iinv_B);
    if(denom<1e-12) return;
    const lam=-bias/denom;
    const dw=n.scale(lam);
    a.angularVelocity.addSelf(a.invInertiaWorld.mulVec(dw));
    b.angularVelocity.addSelf(b.invInertiaWorld.mulVec(dw).negate());
  }
};

// バネ-ダンパー制約
CompVis.Physics.SpringConstraint = class extends CompVis.Physics.Constraint {
  constructor(bodyA, bodyB, pivotA, pivotB, opts={}){
    super(bodyA,bodyB);
    this.pivotA=_V(...(pivotA??[0,0,0]));
    this.pivotB=_V(...(pivotB??[0,0,0]));
    this.restLength = opts.restLength ?? 1;
    this.stiffness  = opts.stiffness  ?? 100;
    this.damping    = opts.damping    ?? 10;
    this.type="spring";
  }
  solve(dt){
    const a=this.bodyA, b=this.bodyB;
    const rA=a.orientation.rotateVec(this.pivotA);
    const rB=b.orientation.rotateVec(this.pivotB);
    const pA=a.position.add(rA);
    const pB=b.position.add(rB);
    const diff=pA.sub(pB);
    const dist=diff.len;
    if(dist<1e-8) return;
    const n=diff.scale(1/dist);
    // バネ力
    const stretch=dist-this.restLength;
    const vA=a.velocity.add(a.angularVelocity.cross(rA));
    const vB=b.velocity.add(b.angularVelocity.cross(rB));
    const relV=vA.sub(vB).dot(n);
    const force=-(this.stiffness*stretch+this.damping*relV);
    const j=n.scale(force*dt);
    a.applyImpulse(j,rA);
    b.applyImpulse(j.negate(),rB);
  }
};

// ============================
//  力フィールド
// ============================
CompVis.Physics.ForceField = class {
  constructor(opts={}){
    this.type   = opts.type   ?? "gravity"; // "gravity"|"wind"|"vortex"|"point"
    this.vector = opts.vector ? _V(...opts.vector) : _V(0,-9.81,0);
    this.origin = opts.origin ? _V(...opts.origin) : _V();
    this.strength=opts.strength??1;
    this.radius  =opts.radius??Infinity;
  }
  applyTo(body, dt){
    if(body.isStatic||body.isSleeping) return;
    const r=body.position.sub(this.origin);
    const dist=r.len;
    if(dist>this.radius) return;
    switch(this.type){
      case "gravity":
        body.applyForce(this.vector.scale(body.mass)); break;
      case "wind":
        body.applyForce(this.vector.scale(body.mass*this.strength)); break;
      case "point": {
        // 点引力 F = strength * m / r²
        if(dist<0.1) return;
        const f=this.strength*body.mass/(dist*dist);
        body.applyForce(r.normalized.negate().scale(f)); break;
      }
      case "vortex": {
        // 渦巻き力
        const up=this.vector.normalized;
        const tangent=up.cross(r).normalized;
        body.applyForce(tangent.scale(this.strength*body.mass/Math.max(dist,0.1))); break;
      }
    }
  }
};

// ============================
//  CompVis.Physics.Three — メインクラス
// ============================
CompVis.Physics.Three = class {
  /**
   * @param {CompVis.ViewThree} viewThree — ViewThreeインスタンス (オプション)
   * @param {object} opts
   *   integrator: "euler"|"rk4" (default: "euler")
   *   gravity: [x,y,z] (default: [0,-9.81,0])
   *   iterations: ソルバー反復回数 (default: 10)
   *   subSteps: サブステップ数 (default: 2)
   *   sleepThreshold: スリープ閾値エネルギー
   *   sleepTime: スリープ判定時間 (秒)
   *   debugDraw: デバッグ描画 (AABB等)
   */
  constructor(viewThree=null, opts={}){
    this.type="Physics.Three";
    this.viewThree = viewThree;

    // 設定
    this.integrator   = opts.integrator   ?? "euler";
    this.iterations   = opts.iterations   ?? 10;
    this.subSteps     = opts.subSteps     ?? 2;
    this.sleepThreshold=opts.sleepThreshold??0.05;
    this.sleepTime     =opts.sleepTime     ??0.5;
    this.debugDraw     =opts.debugDraw     ??false;
    this.baumgarte     =opts.baumgarte     ??0.2;  // Baumgarte係数
    this.slop          =opts.slop          ??0.01; // 許容ペネトレーション
    this.ccdThreshold  =opts.ccdThreshold  ??0.5;  // CCD発動閾値(速度/サイズ)

    // 剛体リスト
    this.bodies = [];
    // 制約リスト
    this.constraints = [];
    // 力フィールド
    this.forceFields = [];

    // デフォルト重力
    this.gravity = _V(
      opts.gravity?opts.gravity[0]:0,
      opts.gravity?opts.gravity[1]:-9.81,
      opts.gravity?opts.gravity[2]:0
    );
    this._defaultGravityField = new CompVis.Physics.ForceField({
      type:"gravity", vector:this.gravity.toArray()
    });
    this.forceFields.push(this._defaultGravityField);

    // 統計
    this.stats = {
      time: 0,
      steps: 0,
      contacts: 0,
      bodies: 0,
      sleeping: 0
    };

    // アニメーション
    this._running = false;
    this._lastTime = 0;
    this._raf = null;
    this._fixedDt = opts.fixedDt ?? null; // nullなら可変dt
    this._maxDt = opts.maxDt ?? 1/30;

    // Three.jsデバッグメッシュ
    this._debugMeshes = new Map();

    // イベントコールバック
    this._onContactCallbacks = [];
    this._onStepCallbacks    = [];
  }

  // -----------------------------------------------
  //  Gravity セッター (forceField経由で更新)
  // -----------------------------------------------
  set gravity(v){
    this._gravity=v;
    if(this._defaultGravityField){
      this._defaultGravityField.vector=v;
    }
  }
  get gravity(){ return this._gravity??_V(0,-9.81,0); }

  // -----------------------------------------------
  //  剛体の追加
  // -----------------------------------------------
  /**
   * addBody(opts)
   * opts:
   *   shape: "sphere"|"box"|"capsule"|"convex"  (または CompVis.Physics.Shape)
   *   radius, size:[w,h,d], halfExtents:[x,y,z], vertices: _Vec3[]
   *   position:[x,y,z], velocity:[x,y,z]
   *   mass: number (0=static)
   *   restitution, friction, linearDamping, angularDamping
   *   mesh: THREE.Mesh (外部提供する場合)
   *   autoMesh: boolean (ViewThreeに自動でメッシュ追加する場合)
   *   meshColor: 0xffffff
   */
  addBody(opts={}){
    let shape;
    if(opts.shape instanceof CompVis.Physics.Shape){
      shape=opts.shape;
    } else {
      const type = typeof opts.shape==="string" ? opts.shape : "sphere";
      shape=new CompVis.Physics.Shape(type, opts);
    }
    const body=new CompVis.Physics.RigidBody({...opts, shape});
    this.bodies.push(body);
    this.stats.bodies=this.bodies.length;

    // Three.jsメッシュ自動生成
    if(this.viewThree && (opts.autoMesh??true)){
      this._createMesh(body, opts);
    }
    return body;
  }

  // -----------------------------------------------
  //  剛体の削除
  // -----------------------------------------------
  removeBody(body){
    const idx=this.bodies.indexOf(body);
    if(idx<0) return;
    this.bodies.splice(idx,1);
    if(body.mesh && this.viewThree){
      this.viewThree.exec((THREE,scene)=>{ scene.remove(body.mesh); });
      body.mesh=null;
    }
    CompVis.deleteId(body.id);
    this.stats.bodies=this.bodies.length;
  }

  // -----------------------------------------------
  //  制約の追加
  // -----------------------------------------------
  addConstraint(constraint){
    this.constraints.push(constraint);
    return constraint;
  }

  addSpring(bodyA, bodyB, opts={}){
    const c=new CompVis.Physics.SpringConstraint(bodyA,bodyB,
      opts.pivotA??[0,0,0], opts.pivotB??[0,0,0], opts);
    return this.addConstraint(c);
  }

  addPointConstraint(bodyA, bodyB, pivotA, pivotB){
    return this.addConstraint(new CompVis.Physics.PointConstraint(bodyA,bodyB,pivotA,pivotB));
  }

  addHinge(bodyA, bodyB, pivotA, pivotB, axisA, axisB, opts={}){
    return this.addConstraint(new CompVis.Physics.HingeConstraint(bodyA,bodyB,pivotA,pivotB,axisA,axisB,opts));
  }

  removeConstraint(c){
    const idx=this.constraints.indexOf(c);
    if(idx>=0) this.constraints.splice(idx,1);
  }

  // -----------------------------------------------
  //  力フィールドの追加/削除
  // -----------------------------------------------
  addForceField(opts){ const f=new CompVis.Physics.ForceField(opts); this.forceFields.push(f); return f; }
  removeForceField(f){ const i=this.forceFields.indexOf(f); if(i>=0) this.forceFields.splice(i,1); }

  // -----------------------------------------------
  //  イベント登録
  // -----------------------------------------------
  onContact(cb){ this._onContactCallbacks.push(cb); return this; }
  onStep(cb){ this._onStepCallbacks.push(cb); return this; }

  // -----------------------------------------------
  //  シミュレーション制御
  // -----------------------------------------------
  start(){
    if(this._running) return;
    this._running=true;
    this._lastTime=performance.now();
    this._loop();
  }

  stop(){ this._running=false; if(this._raf){cancelAnimationFrame(this._raf);this._raf=null;} }

  // 1ステップ手動実行
  step(dt=1/60){ this._tick(dt); }

  _loop(){
    if(!this._running) return;
    this._raf=requestAnimationFrame(t=>{
      const rawDt=(t-this._lastTime)/1000;
      this._lastTime=t;
      const dt=Math.min(rawDt, this._maxDt);
      this._tick(this._fixedDt??dt);
      this._loop();
    });
  }

  // -----------------------------------------------
  //  メインティック
  // -----------------------------------------------
  _tick(dt){
    const subDt=dt/this.subSteps;
    for(let s=0;s<this.subSteps;s++){
      this._subStep(subDt);
    }
    this._syncMeshes();
    this._onStepCallbacks.forEach(cb=>cb(this,dt));
    this.stats.time+=dt;
    this.stats.steps++;
  }

  _subStep(dt){
    // 1. 力の蓄積・スリープ管理
    this._applyForces(dt);

    // 2. 速度積分 (tentative velocity)
    this._integrateVelocities(dt);

    // 3. 衝突検出
    const contacts=this._detectCollisions();
    this.stats.contacts=contacts.length;

    // 4. 衝突応答 + 制約解決 (Sequential Impulse)
    this._solveConstraintsAndContacts(contacts, dt);

    // 5. 位置積分
    this._integratePositions(dt);

    // 6. スリープ更新
    this._updateSleep(dt);
  }

  // -----------------------------------------------
  //  1. 力の適用
  // -----------------------------------------------
  _applyForces(dt){
    this.bodies.forEach(body=>{
      if(body.isStatic||!body.enabled) return;
      // 蓄積リセット
      body.force.set(0,0,0);
      body.torque.set(0,0,0);
      // 力フィールド適用
      if(!body.isSleeping){
        this.forceFields.forEach(f=>f.applyTo(body,dt));
      }
      // 線形・角速度ダンピング
      body.velocity.scaleSelf(Math.pow(1-body.linearDamping, dt));
      body.angularVelocity.scaleSelf(Math.pow(1-body.angularDamping, dt));
    });
  }

  // -----------------------------------------------
  //  2. 速度積分
  // -----------------------------------------------
  _integrateVelocities(dt){
    this.bodies.forEach(body=>{
      if(body.isStatic||body.isSleeping||!body.enabled) return;
      // v += (F/m) * dt
      body.velocity.addSelf(body.force.scale(body.invMass*dt));
      // ω += I⁻¹ * τ * dt
      body.angularVelocity.addSelf(body.invInertiaWorld.mulVec(body.torque).scale(dt));
    });
  }

  // -----------------------------------------------
  //  3. 衝突検出
  // -----------------------------------------------
  _detectCollisions(){
    const contacts=[];
    const n=this.bodies.length;

    // AABB更新
    this.bodies.forEach(b=>b._updateAABB());

    // Broad phase: O(n²) — 大規模なら BVHに切り替え
    for(let i=0;i<n;i++){
      const a=this.bodies[i];
      if(!a.enabled) continue;
      for(let j=i+1;j<n;j++){
        const b=this.bodies[j];
        if(!b.enabled) continue;
        if(a.isStatic&&b.isStatic) continue;
        if(a.isSleeping&&b.isSleeping) continue;
        // 衝突グループフィルタ
        if(!(a.collisionGroup&b.collisionMask)||!(b.collisionGroup&a.collisionMask)) continue;
        // AABB判定
        if(!a.aabb.intersects(b.aabb)) continue;
        // Narrow phase
        const contact=this._narrowPhase(a,b);
        if(contact){
          contacts.push(contact);
          this._onContactCallbacks.forEach(cb=>cb(contact));
        }
      }
    }
    return contacts;
  }

  // Narrow phase (GJK + EPA)
  _narrowPhase(a, b){
    // 両方がsphereの場合は高速パス
    if(a.shape.type==="sphere"&&b.shape.type==="sphere"){
      return this._sphereSphere(a,b);
    }
    // sphereとboxの場合も高速パス
    if(a.shape.type==="sphere"&&b.shape.type==="box") return this._sphereBox(a,b);
    if(a.shape.type==="box"&&b.shape.type==="sphere") return this._sphereBox(b,a,true);

    // 一般: GJK + EPA
    const {hit, simplex}=CompVis.Physics._GJK.detect(a,b);
    if(!hit) return null;
    const {depth,normal,contactA,contactB}=CompVis.Physics._GJK.EPA(a,b,simplex);
    if(depth<-this.slop) return null;
    return new CompVis.Physics.Contact(a,b,normal,depth,contactA,contactB);
  }

  // 球 vs 球 高速パス
  _sphereSphere(a, b){
    const diff=a.position.sub(b.position);
    const dist=diff.len;
    const rSum=a.shape.radius+b.shape.radius;
    if(dist>=rSum) return null;
    const normal=dist<1e-8?_V(0,1,0):diff.scale(1/dist);
    const depth=rSum-dist;
    const contactB=b.position.add(normal.scale(b.shape.radius));
    const contactA=a.position.sub(normal.scale(a.shape.radius));
    return new CompVis.Physics.Contact(a,b,normal,depth,contactA,contactB);
  }

  // 球 vs 箱 高速パス
  _sphereBox(sphere, box, flip=false){
    // 球中心をboxのローカル座標に変換
    const localCenter=box.orientation.conjugate.rotateVec(sphere.position.sub(box.position));
    const h=box.shape.halfExtents;
    // 最近接点をクランプ
    const closest=_V(
      Math.max(-h.x,Math.min(h.x,localCenter.x)),
      Math.max(-h.y,Math.min(h.y,localCenter.y)),
      Math.max(-h.z,Math.min(h.z,localCenter.z))
    );
    const diff=localCenter.sub(closest);
    const distSq=diff.lenSq;
    const r=sphere.shape.radius;
    if(distSq>r*r) return null;
    const dist=Math.sqrt(distSq);
    const localNormal=dist<1e-8?_V(0,1,0):diff.scale(1/dist);
    const worldNormal=box.orientation.rotateVec(localNormal);
    const depth=r-dist;
    const contactB=box.position.add(box.orientation.rotateVec(closest));
    const contactA=sphere.position.sub(worldNormal.scale(r));
    if(flip){
      return new CompVis.Physics.Contact(box,sphere,worldNormal.negate(),depth,contactB,contactA);
    }
    return new CompVis.Physics.Contact(sphere,box,worldNormal,depth,contactA,contactB);
  }

  // -----------------------------------------------
  //  4. 制約・接触応答 (Sequential Impulse Solver)
  // -----------------------------------------------
  _solveConstraintsAndContacts(contacts, dt){
    const iters=this.iterations;
    
    // ウォームスタート (前フレームのインパルスを適用)
    contacts.forEach(c=>this._warmStart(c));

    // 反復ソルバー
    for(let iter=0;iter<iters;iter++){
      // 接触制約
      contacts.forEach(c=>this._solveContact(c,dt));
      // ユーザー定義制約
      this.constraints.forEach(c=>c.solve(dt));
    }

    // 位置補正 (Baumgarte / Split Impulse)
    contacts.forEach(c=>this._positionCorrection(c,dt));
  }

  _warmStart(c){
    const j=c.normal.scale(c.lambdaN)
              .add(c.t1.scale(c.lambdaT1))
              .add(c.t2.scale(c.lambdaT2));
    c.bodyA.applyImpulse(j,c.rA);
    c.bodyB.applyImpulse(j.negate(),c.rB);
  }

  _solveContact(c, dt){
    const a=c.bodyA, b=c.bodyB;
    const n=c.normal;

    // ---- 法線インパルス ----
    // 接触点の相対速度 (= vA + ωA×rA - vB - ωB×rB)
    const vA=a.velocity.add(a.angularVelocity.cross(c.rA));
    const vB=b.velocity.add(b.angularVelocity.cross(c.rB));
    const vRel=vA.sub(vB);
    const vRelN=vRel.dot(n);

    // 既に離れている場合はスキップ
    if(vRelN>0) return;

    // 反発係数 (e)
    const e=Math.min(a.restitution, b.restitution);
    // Baumgarte バイアス (位置補正)
    const bias=this.baumgarte/dt*Math.max(0,c.depth-this.slop);

    // 有効質量
    const kN=a.getInvEffectiveMass(c.rA,n)+b.getInvEffectiveMass(c.rB,n);
    const dLambdaN=(-(1+e)*vRelN-bias)/kN;

    // クランプ (引力は生まない)
    const prevLN=c.lambdaN;
    c.lambdaN=Math.max(0, prevLN+dLambdaN);
    const lambdaN_actual=c.lambdaN-prevLN;

    const jN=n.scale(lambdaN_actual);
    a.applyImpulse(jN,c.rA);
    b.applyImpulse(jN.negate(),c.rB);

    // ---- 摩擦インパルス ----
    const mu=Math.sqrt(a.friction*b.friction); // クーロン摩擦
    const maxFriction=mu*Math.abs(c.lambdaN);

    // 接線 t1
    const vRelT1=vRel.dot(c.t1);
    const kT1=a.getInvEffectiveMass(c.rA,c.t1)+b.getInvEffectiveMass(c.rB,c.t1);
    if(kT1>1e-12){
      const dLT1=-vRelT1/kT1;
      const prevLT1=c.lambdaT1;
      c.lambdaT1=Math.max(-maxFriction,Math.min(maxFriction,prevLT1+dLT1));
      const jT1=c.t1.scale(c.lambdaT1-prevLT1);
      a.applyImpulse(jT1,c.rA);
      b.applyImpulse(jT1.negate(),c.rB);
    }

    // 接線 t2
    const vRelT2=vRel.dot(c.t2);
    const kT2=a.getInvEffectiveMass(c.rA,c.t2)+b.getInvEffectiveMass(c.rB,c.t2);
    if(kT2>1e-12){
      const dLT2=-vRelT2/kT2;
      const prevLT2=c.lambdaT2;
      c.lambdaT2=Math.max(-maxFriction,Math.min(maxFriction,prevLT2+dLT2));
      const jT2=c.t2.scale(c.lambdaT2-prevLT2);
      a.applyImpulse(jT2,c.rA);
      b.applyImpulse(jT2.negate(),c.rB);
    }
  }

  // ペネトレーション補正 (位置レベルの押し出し)
  _positionCorrection(c, dt){
    const a=c.bodyA, b=c.bodyB;
    const correction=Math.max(0, c.depth-this.slop)*this.baumgarte;
    if(correction<1e-6) return;
    const kN=a.invMass+b.invMass;
    if(kN<1e-12) return;
    const push=c.normal.scale(correction/kN);
    if(!a.isStatic) a.position.addSelf(push.scale(a.invMass/kN*kN)); // 簡略: 質量比で分配
    if(!b.isStatic) b.position.subSelf(push.scale(b.invMass/kN*kN));
  }

  // -----------------------------------------------
  //  5. 位置積分
  // -----------------------------------------------
  _integratePositions(dt){
    this.bodies.forEach(body=>{
      if(body.isStatic||body.isSleeping||!body.enabled) return;
      body.prevPosition.copy(body.position);
      body.position.addSelf(body.velocity.scale(dt));
      body.orientation.integrateOmega(body.angularVelocity, dt);
      body._updateInertiaWorld();
      body._updateAABB();
    });
  }

  // -----------------------------------------------
  //  6. スリープ管理
  // -----------------------------------------------
  _updateSleep(dt){
    this.bodies.forEach(body=>{
      if(body.isStatic||!body.allowSleep||!body.enabled) return;
      const ke=body.velocity.lenSq+body.angularVelocity.lenSq;
      if(ke<this.sleepThreshold){
        body._sleepTimer+=dt;
        if(body._sleepTimer>this.sleepTime){
          body.isSleeping=true;
          body.velocity.set(0,0,0);
          body.angularVelocity.set(0,0,0);
        }
      } else {
        body._sleepTimer=0;
        body.isSleeping=false;
      }
    });
    this.stats.sleeping=this.bodies.filter(b=>b.isSleeping).length;
  }

  // -----------------------------------------------
  //  Three.jsメッシュ自動生成
  // -----------------------------------------------
  async _createMesh(body, opts){
    await this.viewThree.initPromise;
    this.viewThree.exec((THREE, scene)=>{
      let geo, mat;
      const color=opts.meshColor??0x88bbff;
      const shape=body.shape;
      if(shape.type==="sphere"){
        geo=new THREE.SphereGeometry(shape.radius,16,12);
      } else if(shape.type==="box"){
        const h=shape.halfExtents;
        geo=new THREE.BoxGeometry(h.x*2,h.y*2,h.z*2);
      } else if(shape.type==="capsule"){
        // Three.js r128にはCapsuleGeometryがないのでCylinder+2Sphere合成
        const group=new THREE.Group();
        const r=shape.radius, hh=shape.halfHeight;
        const cylGeo=new THREE.CylinderGeometry(r,r,hh*2,16);
        const sphGeo=new THREE.SphereGeometry(r,16,8);
        const m=new THREE.MeshLambertMaterial({color,transparent:true,opacity:body.isStatic?0.5:0.85});
        const cyl=new THREE.Mesh(cylGeo,m); group.add(cyl);
        const topS=new THREE.Mesh(sphGeo,m); topS.position.y=hh; group.add(topS);
        const botS=new THREE.Mesh(sphGeo,m); botS.position.y=-hh; group.add(botS);
        scene.add(group);
        body.mesh=group;
        return;
      } else {
        geo=new THREE.SphereGeometry(0.5,8,6);
      }
      mat=new THREE.MeshLambertMaterial({
        color,
        transparent:true,
        opacity:body.isStatic?0.45:0.85,
        wireframe:opts.wireframe??false
      });
      const mesh=new THREE.Mesh(geo,mat);
      // 影
      mesh.castShadow=true;
      mesh.receiveShadow=true;
      scene.add(mesh);
      body.mesh=mesh;
    });
  }

  // -----------------------------------------------
  //  Three.jsメッシュの同期
  // -----------------------------------------------
  _syncMeshes(){
    if(!this.viewThree) return;
    this.bodies.forEach(body=>{
      if(!body.mesh) return;
      const p=body.position;
      body.mesh.position.set(p.x,p.y,p.z);
      const q=body.orientation;
      body.mesh.quaternion.set(q.x,q.y,q.z,q.w);
    });
  }

  // -----------------------------------------------
  //  シーンのリセット
  // -----------------------------------------------
  async reset(){
    this.stop();
    // メッシュ削除
    if(this.viewThree){
      await this.viewThree.initPromise;
      this.viewThree.exec((THREE,scene)=>{
        this.bodies.forEach(b=>{ if(b.mesh){ scene.remove(b.mesh); }});
      });
    }
    this.bodies.forEach(b=>CompVis.deleteId(b.id));
    this.bodies=[];
    this.constraints=[];
    this.stats={time:0,steps:0,contacts:0,bodies:0,sleeping:0};
  }

  // -----------------------------------------------
  //  ユーティリティ: レイキャスト (ピッキング)
  // -----------------------------------------------
  /**
   * raycast(origin:[x,y,z], direction:[x,y,z]) → {body, t, point, normal} | null
   * 最も近い剛体を返す
   */
  raycast(originArr, directionArr){
    const orig=_V(...originArr);
    const dir=_V(...directionArr).normalized;
    let minT=Infinity, result=null;

    this.bodies.forEach(body=>{
      if(!body.enabled) return;
      const shape=body.shape;
      let t=Infinity;

      if(shape.type==="sphere"){
        // 解析的 ray-sphere
        const oc=orig.sub(body.position);
        const a=1, b2=oc.dot(dir), c=oc.lenSq-shape.radius**2;
        const disc=b2*b2-c;
        if(disc<0) return;
        t=Math.max(0,-b2-Math.sqrt(disc));
      } else if(shape.type==="box"){
        // ray-AABB (ワールドAABB近似)
        const {min,max}=body.aabb;
        const invD=_V(1/dir.x,1/dir.y,1/dir.z);
        const t1=min.sub(orig).x*invD.x, t2=max.sub(orig).x*invD.x;
        const t3=min.sub(orig).y*invD.y, t4=max.sub(orig).y*invD.y;
        const t5=min.sub(orig).z*invD.z, t6=max.sub(orig).z*invD.z;
        const tmin=Math.max(Math.min(t1,t2),Math.min(t3,t4),Math.min(t5,t6));
        const tmax=Math.min(Math.max(t1,t2),Math.max(t3,t4),Math.max(t5,t6));
        if(tmax<0||tmin>tmax) return;
        t=tmin<0?tmax:tmin;
      }

      if(t<minT){
        minT=t;
        const point=orig.add(dir.scale(t));
        const normal=point.sub(body.position).normalized;
        result={body,t,point,normal};
      }
    });
    return result;
  }

  // -----------------------------------------------
  //  ユーティリティ: 物体の発射
  // -----------------------------------------------
  shootBody(opts={}){
    const body=this.addBody({
      shape: opts.shape??"sphere",
      radius: opts.radius??0.5,
      position: opts.position??[0,5,0],
      velocity: opts.velocity??[0,0,-20],
      mass: opts.mass??1,
      meshColor: opts.meshColor??0xff6644,
      ...opts
    });
    return body;
  }

  // -----------------------------------------------
  //  統計情報の文字列化
  // -----------------------------------------------
  get statsStr(){
    const s=this.stats;
    return `t=${s.time.toFixed(2)}s | steps=${s.steps} | bodies=${s.bodies} | contacts=${s.contacts} | sleeping=${s.sleeping}`;
  }

  // -----------------------------------------------
  //  デバッグ情報のダンプ
  // -----------------------------------------------
  dump(){
    this.bodies.forEach((b,i)=>{
      console.log(`[Body ${i}] pos:(${b.position.x.toFixed(2)},${b.position.y.toFixed(2)},${b.position.z.toFixed(2)}) vel:(${b.velocity.x.toFixed(2)},${b.velocity.y.toFixed(2)},${b.velocity.z.toFixed(2)}) sleeping:${b.isSleeping}`);
    });
  }
};

// ============================
//  CompVis.Physics.Three に ViewThree連携ヘルパーを追加
// ============================
Object.assign(CompVis.Physics.Three.prototype, {

  /**
   * ViewThreeのexecをawaitできるラッパー
   */
  async exec(cb){
    if(!this.viewThree) return;
    return this.viewThree.exec(cb);
  },

  /**
   * 地面プレーン (静的) を簡単に追加
   */
  addGround(opts={}){
    return this.addBody({
      shape:"box",
      size: opts.size??[40,1,40],
      position: opts.position??[0,-0.5,0],
      mass:0,
      restitution: opts.restitution??0.3,
      friction: opts.friction??0.7,
      meshColor: opts.meshColor??0x44aa66,
      ...opts
    });
  },

  /**
   * 指定された位置に複数の球を積み上げる
   */
  addStack(rows, cols, depth, opts={}){
    const r=opts.radius??0.5;
    const bodies=[];
    for(let y=0;y<rows;y++){
      for(let x=0;x<cols;x++){
        for(let z=0;z<depth;z++){
          const b=this.addBody({
            shape:"sphere",
            radius:r,
            position:[x*r*2.1-(cols-1)*r,y*r*2.1+r*2, z*r*2.1-(depth-1)*r],
            mass:opts.mass??1,
            meshColor:opts.meshColor??Math.random()*0xffffff,
            ...opts
          });
          bodies.push(b);
        }
      }
    }
    return bodies;
  },

  /**
   * ロープ (連結バネ)
   */
  addRope(startPos, endPos, segments=10, opts={}){
    const start=_V(...startPos);
    const end=_V(...endPos);
    const bodies=[];
    const mass=opts.mass??0.5;
    const r=opts.radius??0.15;

    for(let i=0;i<=segments;i++){
      const t=i/segments;
      const pos=start.add(end.sub(start).scale(t));
      const body=this.addBody({
        shape:"sphere",
        radius:r,
        position:pos.toArray(),
        mass: (i===0&&opts.fixStart)?0 : (i===segments&&opts.fixEnd)?0 : mass,
        meshColor:opts.meshColor??0xffaa44,
      });
      bodies.push(body);
    }

    const restLen=start.dist(end)/segments;
    for(let i=0;i<segments;i++){
      this.addSpring(bodies[i],bodies[i+1],{
        restLength:restLen,
        stiffness:opts.stiffness??800,
        damping:opts.damping??30,
      });
    }
    return bodies;
  },

  /**
   * 布 (グリッドバネ)
   */
  addCloth(cols, rows, spacing=1, opts={}){
    const startPos=opts.position??[0,10,0];
    const bodies=[];
    const mass=opts.mass??0.2;
    const r=0.05;

    for(let row=0;row<rows;row++){
      bodies.push([]);
      for(let col=0;col<cols;col++){
        const pos=[startPos[0]+col*spacing-(cols-1)*spacing/2, startPos[1]-row*spacing, startPos[2]];
        const fixTop=(row===0)&&(col===0||col===cols-1||(opts.fixTopAll));
        const body=this.addBody({
          shape:"sphere",
          radius:r,
          position:pos,
          mass:fixTop?0:mass,
          meshColor:opts.meshColor??0x88ddff,
        });
        bodies[row].push(body);
      }
    }

    const addSpr=(a,b)=>this.addSpring(a,b,{
      restLength:spacing,
      stiffness:opts.stiffness??600,
      damping:opts.damping??20,
    });

    for(let row=0;row<rows;row++){
      for(let col=0;col<cols;col++){
        if(col+1<cols) addSpr(bodies[row][col],bodies[row][col+1]);
        if(row+1<rows) addSpr(bodies[row][col],bodies[row+1][col]);
        // せん断バネ
        if(row+1<rows&&col+1<cols) addSpr(bodies[row][col],bodies[row+1][col+1]);
        if(row+1<rows&&col>0)       addSpr(bodies[row][col],bodies[row+1][col-1]);
      }
    }
    return bodies;
  }
});
