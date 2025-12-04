CompVis.Physics = class {
  constructor ({gravity=new CompVis.Vector(0,-9.8,0),wind=new CompVis.Vector(0,0,0)}={}) {
    this.objects = {};
    this.gravity = gravity ?? new CompVis.Vector(0,-9.8,0);
    this.wind = wind ?? new CompVis.Vector(0,0,0);
    this.idMax = 0;
    this.elapsedTime = 0;
    this.mutualCor = "mean" // または"min"
  }
  
  #miniAddObject(shape, {
        cor=1, // 反発係数
        noGravity=false,
        noCollision=false,
        boundingType="box",
        mass=1, // 質量
        airResistance=0,
        inertia=null,
        id=null
      }={}, changeId=null) {
    
    // ※boundingTypeにsphereの実装をまだ行わない！
    if(boundingType=="sphere") throw new Error("現在、boundingTypeにbox以外を指定することはできません。\n今後sphereやcapselを実装する予定です。")
    
    let key;
    
    const change = Number.isInteger(changeId) && this.objects[changeId] != null;
    if(change) {
      const obj_k = this.objects[changeId];
      cor = obj_k.cor;
      noGravity = obj_k.noGravity;
      noCollision = obj_k.noCollision;
      boundingType = obj_k.boundingType;
      mass = obj_k.mass;
      airResistance = obj_k.airResistance;
      inertia = obj_k.inertia;
    }
    
    if(cor == null || shape==null || boundingType==null || noCollision==null || mass==null || airResistance==null) {
      throw new Error("addObject < Physics");
    }
    if(boundingType == "box") {
      shape.halfSize = {};
      shape.halfSize.x = shape.size.x/2;
      shape.halfSize.y = shape.size.y/2;
      shape.halfSize.z = shape.size.z/2;
      /* 例
      obj={
          size: {x: 10, y: 5, z: 10},
          position: {x: 0, y: 5, z: -10},
        }
      */
      if(shape.halfSize == null || shape.position == null) throw new Error("addObject < Physics");
      if (shape.rotation == null) shape.rotation = new CompVis.Quater(1, 0, 0, 0);
      
      if(id != null) key = id;
      else if(!change) {
        this.idMax++;
        key = String(this.idMax);
      } else {
        key = changeId;
      }
      this.objects[key] = new CompVis.Box({
        halfSize: shape.halfSize,
        rotation: shape.rotation,
        inertia // uniqueに入れるのは、初期値が異なるため
      }, {
        position: shape.position,
        cor,
        noGravity,
        noCollision,
        boundingType: "box",
        mass,
        airResistance
      });
    } else if(boundingType == "sphere") {
      if(shape.position == null || shape.radius == null) throw new Error("addObject < Physics");
      /* 例
      obj={
          position: {x: -5, y: 0, z: 10},
          radius: 5
        }
      */
      if(id != null) key = id;
      else if(!change) {
        this.idMax++;
        key = String(this.idMax);
      } else {
        key = changeId;
      }
      this.objects[key] = {
        position: shape.position,
        radius: shape.radius,
        cor,
        noGravity,
        noCollision,
        boundingType: "sphere",
        mass,
        airResistance,
        inertia
      };
    }
    
    return key;
  }
  
  addObject(obj) {
    if(Array.isArray(obj)) {
      const list = [];
      for(let k of obj) {
        if(k.id != null) {
          if((!Number.isFinite(k.id) && typeof k.id !== "string") || String(k.id) in this.objects) throw new Error("addObject < Physics : Argument 'key'("+String(k.id)+") is already in use OR invalid key.");
          else k.id = String(k.id);
        }
        const shape = {
          size: k.size,
          position: k.position,
          rotation: k.rotation,
          radius: k.radius
        }
        list.push(this.#miniAddObject(shape, k));
      }
      return list;
    }
    if(obj.id != null) {
      if(
        (
          !Number.isFinite(obj.id)
          && typeof obj.id !== "string"
        )
        || String(obj.id) in Object.keys(this.objects)
      ) throw new Error("addObject < Physics : Argument 'key'("+String(obj.id)+") is already in use OR invalid key.");
      else k.id = String(k.id);
    }
    const shape = {
      size: obj.size,
      position: obj.position,
      rotation: obj.rotation,
      radius: obj.radius
    }
    return this.#miniAddObject(shape, obj);
  }

  changeShape(obj) {
    if(Array.isArray(obj)) {
      let list = [];
      for(let k of obj) {
        if(!Number.isInteger(k.id) || this.objects[k.id] == null) throw new Error("changeShape < Physics");
        const shape = {
          size: k.size,
          position: k.position,
          rotation: k.rotation,
          radius: k.radius
        }
        list.push(this.#miniAddObject(shape, k, k.id));
      }
      return list;
    }
    if(!Number.isInteger(obj.id) || this.objects[obj.id] == null) throw new Error("changeShape < Physics");
    const shape = {
      size: obj.size,
      position: obj.position,
      rotation: obj.rotation,
      radius: obj.radius
    }
    return this.#miniAddObject(shape, obj, obj.id);
  }
  
  deleteObject(del) {
    if(Array.isArray(del)) {
      for(let k of del) {
        if(!Number.isInteger(k) || this.objects[k] == null) throw new Error("deleteObject < Physics");
        delete this.objects[k];
      }
      return;
    }
    if(!Number.isInteger(del) || this.objects[del] == null) throw new Error("deleteObject < Physics");
    delete this.objects[del];
    return;
  }
  
  getObject(key) {
    return this.objects[key];
  }
  
  step(dt) { // dtは[s]
    for(let id in this.objects) {
      const obj = this.objects[id];
      if(!obj.noGravity) obj.velocity = obj.velocity.add(this.gravity.scale(dt));
      
      if (Number.isFinite(obj.mass)) { 
        const airF = 1/2*obj.airResistance*(obj.velocity.abs**2);
        obj.addForce(obj.velocity.normalize.scale(-airF));
      }
      
      obj.moveCalc(dt);
      this.collision();
      
      /*if (obj.velocity.abs > 10e-5 || obj.angVelocity.abs > 10e-5) {
          console.log(`[ID ${id}] End V: ${obj.velocity.str} | End ω: ${obj.angVelocity.str}`);
      }*/
      
      obj.reset();
    }
    this.elapsedTime += dt;
  }

  static miniBBCollision(A0,B0) {
    /*
      A,B: 軸のベクトルを引数に取る。長さ3のVectorの配列
      aPos,bPos: 物体の位置(中心)を表すVector
    */
    const A = A0.axes;
    const aPos = A0.position;
    const B = B0.axes;
    const bPos = B0.position;
    
    let collidedAxis = null;
    
    let collisionTf = false;
    const C = A.map(a => B.map(b => a.cross(b)));
    const I = aPos.sub(bPos);
    let MTV = {depth:-Infinity,normal:null};
    function checkAndReturn(rA,rB,L,separatingAxis) {
      const l = L-rA-rB; // 負の値で めり込んでる
      const Idot = I.dot(separatingAxis);
      const normal = Idot < 0 ? separatingAxis.clone : separatingAxis.negate;
      // 衝突なし
      if(l>=0) return true;
      
      if(l>MTV.depth) {
        /*const axisDirectionFromAtoB = separatingAxis;
        const shouldFlip = I.dot(separatingAxis) > 0;
        const normal = !shouldFlip ? axisDirectionFromAtoB.negate : axisDirectionFromAtoB.clone;*/
        const Idot = I.dot(separatingAxis);
        const normal = Idot > 0 ? separatingAxis.clone : separatingAxis.negate;
        MTV = {depth:l,normal,collidedAxis};
      }
      return false;
    }
    
    
    
    // A0
    let a,aUnit,b,bUnit,c,rA,rB,L;
    a=A[0];aUnit=a.normalize;
    rA = a.abs;
    rB = Math.abs(B[0].dot(aUnit))+Math.abs(B[1].dot(aUnit))+Math.abs(B[2].dot(aUnit));
    L = Math.abs(I.dot(aUnit));
    collidedAxis = "A0";
    if(checkAndReturn(rA,rB,L,aUnit)) return false;
    
    a=A[1];aUnit=a.normalize;
    rA = a.abs;
    rB = Math.abs(B[0].dot(aUnit))+Math.abs(B[1].dot(aUnit))+Math.abs(B[2].dot(aUnit));
    L = Math.abs(I.dot(aUnit));
    collidedAxis = "A1"
    if(checkAndReturn(rA,rB,L,aUnit)) return false;
    
    a=A[2];aUnit=a.normalize;
    rA = a.abs;
    rB = Math.abs(B[0].dot(aUnit))+Math.abs(B[1].dot(aUnit))+Math.abs(B[2].dot(aUnit));
    L = Math.abs(I.dot(aUnit));
    collidedAxis = "A2"
    if(checkAndReturn(rA,rB,L,aUnit)) return false;
    
    b=B[0];bUnit=b.normalize;
    rA = Math.abs(A[0].dot(bUnit))+Math.abs(A[1].dot(bUnit))+Math.abs(A[2].dot(bUnit));
    rB = b.abs;
    L = Math.abs(I.dot(bUnit));
    collidedAxis = "B0";
    if(checkAndReturn(rA,rB,L,bUnit)) return false;
    
    b=B[1];bUnit=b.normalize;
    rA = Math.abs(A[0].dot(bUnit))+Math.abs(A[1].dot(bUnit))+Math.abs(A[2].dot(bUnit));
    rB = b.abs;
    L = Math.abs(I.dot(bUnit));
    collidedAxis = "B1";
    if(checkAndReturn(rA,rB,L,bUnit)) return false;
    
    b = B[2];bUnit=b.normalize;
    rA = Math.abs(A[0].dot(bUnit))+Math.abs(A[1].dot(bUnit))+Math.abs(A[2].dot(bUnit));
    rB = b.abs;
    L = Math.abs(I.dot(bUnit));
    collidedAxis = "B2";
    if(checkAndReturn(rA,rB,L,bUnit)) return false;
    
    for(let a_ind = 0; a_ind <= 2; a_ind++) {
      for(let b_ind = 0; b_ind <= 2; b_ind++) {
        const a_1 = (a_ind+1) % 3;
        const a_2 = (a_ind+2) % 3;
        const b_1 = (b_ind+1) % 3;
        const b_2 = (b_ind+2) % 3;
        
        c = C[a_ind][b_ind];
        if(c.abs < 10e-5) continue;
        c = c.normalize;
        rA = Math.abs(A[a_1].dot(c))+Math.abs(A[a_2].dot(c));
        rB = Math.abs(B[b_1].dot(c))+Math.abs(B[b_2].dot(c));
        L = Math.abs(I.dot(c));
        collidedAxis = "C"+String(a_ind)+String(b_ind);
        if(checkAndReturn(rA,rB,L,c)) return false;
      }
    }
    
    //cobsole.log(MTV.collidedAxis,MTV.normal);
    return MTV;
  }
  
  static miniClip(A,AData,B,BData,mtv) {
    //const I = A.position.sub(B.position);
    const n = mtv.normal;
    
    let aMax = {dot:Infinity,axis:null,ind:null,sign:null};
    let bMax = {dot:-Infinity,axis:null,ind:null,sign:null};
    for(let k = 0; k < 3; k++) {
      const aAxis = AData.axes[k];
      const aDot = aAxis.normalize.dot(n);
      if(aMax.dot > aDot) aMax = {
        dot:aDot,
        axis:aAxis.normalize,
        ind:k,
        sign:1
      };
      if(aMax.dot > -aDot) aMax = {
        dot:-aDot,
        axis:aAxis.negate.normalize,
        ind:k,
        sign:-1
      };
      
      const bAxis = BData.axes[k];
      const bDot = bAxis.normalize.dot(n);
      if(bMax.dot < bDot) bMax = {
        dot:bDot,
        axis:bAxis.normalize,
        ind:k,
        sign:1
      };
      if(bMax.dot < -bDot) bMax = {
        dot:-bDot,
        axis:bAxis.negate.normalize,
        ind:k,
        sign:-1
      };
    }
    
    const absDotA = Math.abs(aMax.dot);
    const absDotB = Math.abs(bMax.dot);

    let ref, inc, refAxisVec, incAxisVec, refAxisKind;
    
    if (absDotA > absDotB) {
      ref = A; // constだから浅いコピーで問題ない
      inc = B;
      refAxisVec = aMax.axis;
      incAxisVec = bMax.axis;
      refAxisKind = {ind:aMax.ind,sign:aMax.sign};
    } else {
      ref = B;
      inc = A;
      refAxisVec = bMax.axis;
      incAxisVec = aMax.axis;
      refAxisKind = {ind:bMax.ind,sign:bMax.sign};
    }
    
    const contacts = CompVis.Physics.generateContactManifold(
      A,B,ref, inc, n, refAxisVec, incAxisVec, refAxisKind, mtv.depth
    );
    
    return contacts;
  }
  
  static generateContactManifold(A,B,ref,inc,n,refAxisVec,incAxisVec,refAxisKind,depth) {
    n = n.clone;
    if(ref === B) {
      n = n.negate;
    }
    
    let inputVertices = inc.getFaceVertices(n.negate); // incVertices の内容
    
    const refPlanes = CompVis.Physics.#defineReferencePlanes(ref,refAxisVec,refAxisKind);
    
    for(const plane of refPlanes) {
        inputVertices = CompVis.Physics.clipPolygonAgainstPlane(inputVertices, plane);
        
        // 頂点がゼロになったら、重なりがないので終了
        if (inputVertices.length === 0) {
            break; 
        }
    }

    // 最終的なクリッピング結果が inputVertices に残る
    const clippedVertices = inputVertices;
    
    const contacts = clippedVertices.map(vertex => {
      return {
        position: vertex,
        normal: n,
        penetration: depth
      }
    });
    
    return contacts;
  }

static clipPolygonAgainstPlane(inputVertices, plane) {
    const outputVertices = [];
    if (inputVertices.length < 2) return outputVertices;
    
    // 頂点を循環させるため、最初の頂点を最後の頂点の次に設定
    let s = inputVertices[inputVertices.length - 1]; // Start Vertex (前頂点)
    
    // 前頂点の平面からの符号付き距離
    let d_s = s.sub(plane.point).dot(plane.normal); 
    let s_isInside = (d_s <= 0); // 平面の内側（d <= 0）か判定
    
    // 各頂点を巡回 (e = End Vertex)
    for (const e of inputVertices) {
        const d_e = e.sub(plane.point).dot(plane.normal);
        const e_isInside = (d_e <= 0); // 現頂点の平面からの判定
        
        // パターン 1 & 2: Inside -> ... (前頂点が内側)
        if (s_isInside) {
            if (e_isInside) { 
                // Inside -> Inside: 現頂点を追加
                outputVertices.push(e);
            } else { 
                // Inside -> Outside: 交点を計算して追加
                const t = d_s / (d_s - d_e); // tは0から1の間の係数
                const intersection = s.lerp(e, t); // 線形補間
                outputVertices.push(intersection);
            }
        } 
        // パターン 3 & 4: Outside -> ... (前頂点が外側)
        else { 
            if (e_isInside) { 
                // Outside -> Inside: 
                // 1. 交点を計算して追加
                const t = d_s / (d_s - d_e);
                const intersection = s.lerp(e, t);
                outputVertices.push(intersection);
                
                // 2. 現頂点を追加
                outputVertices.push(e);
            } 
            // Outside -> Outside: 何もしない
        }
        
        // 次のループのために頂点を更新
        s = e;
        d_s = d_e;
        s_isInside = e_isInside;
    }

    return outputVertices;
}
  
  static #defineReferencePlanes(ref, refAxisVec, refAxisKind) {
    const refPos = ref.position;
    
    const halfSize = [ref.halfSize.x,ref.halfSize.y,ref.halfSize.z];
    const aDataAxes = ref.getCollisionData.axes;
    
    const faceCenter = ref.position.add(refAxisVec.scale(halfSize[refAxisKind.ind]));
    
    const uInd = (refAxisKind.ind + 1) % 3;
    const vInd = (refAxisKind.ind + 2) % 3
    // 側面
    const u = aDataAxes[uInd];
    const v = aDataAxes[vInd];
    
    return [
      { normal: u, point: faceCenter.add(u.scale(halfSize[uInd])) },
      { normal: u.negate, point: faceCenter.add(u.negate.scale(halfSize[uInd])) },
      { normal: v, point: faceCenter.add(v.scale(halfSize[vInd])) },
      { normal: v.negate, point: faceCenter.add(v.negate.scale(halfSize[vInd])) },
    ];

  }
  
  #miniResolvePenetration(A, B, mtv, divisions) { // 一回分
    const isAMassless = !Number.isFinite(A.mass) || A.mass <= 0;
    const isBMassless = !Number.isFinite(B.mass) || B.mass <= 0;

    // 両方とも固定されている場合は何もしない
    if (isAMassless && isBMassless) return;

    // 逆質量を計算
    const invMassA = isAMassless ? 0 : 1 / A.mass;
    const invMassB = isBMassless ? 0 : 1 / B.mass;
    const totalInvMass = invMassA + invMassB;
    
    if (totalInvMass === 0) return;

    const penetrationDepth = -mtv.depth;
    const normal = mtv.normal;

    // 微小なめり込みを無視するしきい値 (Slop)
    const slop = 10e-3; 
    // 修正する割合 (Bias/Baudrate)。ゆっくりと修正することで安定性を高めます。
    const percent = 0.4;
    
    const correctionMagnitude = Math.max(penetrationDepth-slop, 0) * percent;

    // 修正ベクトル
    const correctionVector = normal.scale(correctionMagnitude);

    // オブジェクトAの位置修正
    if (invMassA !== 0) {
      // Aは法線と反対方向に移動 (mass Aの比率)
      const moveA = correctionVector.scale(invMassA / totalInvMass);
      A.position = A.position.add(moveA);
    }
    // オブジェクトBの位置修正
    if (invMassB !== 0) {
      // Bは法線と同じ方向に移動 (mass Bの比率)
      const moveB = correctionVector.scale(invMassB / totalInvMass);
      B.position = B.position.sub(moveB);
    }
  }
  
  #miniResolveCollision(A, B, contacts) {
    
    const cor = this.mutualCor === "min" ? Math.min(A.cor, B.cor) : (A.cor + B.cor) / 2;
    
    const invMassA = !Number.isFinite(A.mass) || A.mass <= 0 ? 0 : 1 / A.mass;
    const invMassB = !Number.isFinite(B.mass) || B.mass <= 0 ? 0 : 1 / B.mass;
    
    // =========================================================================
    // ★ 必須修正: ワールド慣性テンソル逆行列の計算 (QuaterToMatrixを使用)
    // =========================================================================
    const R_A = CompVis.QuaterToMatrix3x3(A.rotation);
    const invInertiaA_world = R_A.pro(A.inertia.scale(2)._inverse).pro(R_A.transpose);
    

    const R_B = CompVis.QuaterToMatrix3x3(B.rotation);
    const invInertiaB_world = R_B.pro(B.inertia._inverse).pro(R_B.transpose);
    // =========================================================================

    if (invMassA === 0 && invMassB === 0) return;

    for (const contact of contacts) {
        const n = contact.normal;
        const p = contact.position; 
        const rA = p.sub(A.position);
        const rB = p.sub(B.position);
        
        const vA_at_contact = A.velocity.add(A.angVelocity.cross(rA));
        const vB_at_contact = B.velocity.add(B.angVelocity.cross(rB));
        const relativeVelocity = vA_at_contact.sub(vB_at_contact);
        const separatingSpeed = relativeVelocity.dot(n);
        //console.log(separatingSpeed)
        
        //if (separatingSpeed < 10e-5) continue;
        
        const desiredDeltaV_n = -(1 + cor) * separatingSpeed;
        let denominator = invMassA + invMassB;
        
        // オブジェクト A の回転項
        if (invMassA !== 0) {
            /*const cross_rA_n = rA.cross(n);
            const I_inv_cross_rA_n = invInertiaA_world.mulVector(cross_rA_n);
            const cross_I_inv_rA = I_inv_cross_rA_n.cross(rA);
            denominator += n.dot(cross_I_inv_rA);*/
          const cross_rA_n = rA.cross(n); // r x n
    const I_inv_cross_rA_n = invInertiaA_world.mulVector(cross_rA_n); // I^-1 * (r x n)
    
    // 【修正後の正しい計算】: (r x n) . (I^-1 * (r x n))
    denominator += cross_rA_n.dot(I_inv_cross_rA_n);
        }
        
        // オブジェクト B の回転項
        if (invMassB !== 0) {
            /*const cross_rB_n = rB.cross(n);
            const I_inv_cross_rB_n = invInertiaB_world.mulVector(cross_rB_n);
            const cross_I_inv_rB = I_inv_cross_rB_n.cross(rB);
            denominator += n.dot(cross_I_inv_rB);*/
          const cross_rB_n = rB.cross(n); // r x n
          const I_inv_cross_rB_n = invInertiaB_world.mulVector(cross_rB_n);
          denominator += cross_rB_n.dot(I_inv_cross_rB_n);
          
        }
      
        if (denominator < 10e-9) continue;
      
        
        const impulseMagnitude_n = desiredDeltaV_n / denominator;
        const J = n.scale(impulseMagnitude_n);
      /*if(!window.count) window.count = 0;
      if(window.count < 50) console.log(J.str);
      window.count ++;*/
     

        // =================================================================
        // ★ デバッグ用: 計算されたインパルス J の表示
        // =================================================================
        //console.log(`[Impulse] J Magnitude: ${impulseMagnitude_n.toFixed(4)} | N: ${n.str}`);
        //this.sks.skskx.sisid

        // オブジェクト A の更新
        if (invMassA !== 0) {
            // ★ 修正点: 並進速度の更新 (A.velocity = v + J/m)
            A.velocity = A.velocity.add(J.scale(invMassA));
            
            const torqueA = rA.cross(J);
            const deltaAngularA = invInertiaA_world.mulVector(torqueA); 
            //console.log(deltaAngularA.str)
            // ★ デバッグ用: Aの角速度変化量の表示
            //console.log(`[A] ΔV: ${J.scale(invMassA).str} | Δω: ${deltaAngularA.str}`);
          
            
            A.angVelocity = A.angVelocity.add(deltaAngularA);
        }
        
        // オブジェクト B の更新
        if (invMassB !== 0) {
            // ★ 修正点: 並進速度の更新 (B.velocity = v - J/m)
            B.velocity = B.velocity.sub(J.scale(invMassB));

            const torqueB = rB.cross(J.negate);
            const deltaAngularB = invInertiaB_world.mulVector(torqueB);
            
            // ★ デバッグ用: Bの角速度変化量の表示
            //console.log(`[B] ΔV: ${J.scale(invMassB).negate.str} | Δω: ${deltaAngularB.negate.str}`); // BはJを引くため
            
            B.angVelocity = B.angVelocity.add(deltaAngularB);
          
        }
    }
}

  collision() {
    const iterations = 10;
    const objKeys = Object.keys(this.objects);
    
    for(let k = 0; k < iterations; k++) {
      const CollisionDataList = []; // MTVListから名前を変更
      for(let A_ind = 0; A_ind < objKeys.length; A_ind++) {
        const A_key = objKeys[A_ind];
        const A = this.objects[A_key];
        if(A.noCollision) continue;
        for(let B_ind = A_ind+1; B_ind < objKeys.length; B_ind++) {
          const B_key = objKeys[B_ind];
          const B = this.objects[B_key];
          if(B.noCollision) continue;
          
          if(A.boundingType == "box" && B.boundingType == "box") {
            const AData = A.getCollisionData;
            const BData = B.getCollisionData;
            const mtv = CompVis.Physics.miniBBCollision(AData,BData);
            if(mtv == false || mtv.depth >= 0) continue;
            
            // 接触点多様体 (Contact Manifold) の生成
            const contacts = CompVis.Physics.miniClip(A, AData, B, BData, mtv);
            
            // MTV (めり込み解消) と contacts (速度更新) の両方を格納
            CollisionDataList.push({A, B, mtv, contacts});
          }
        }
      }
      
      if(k == 0) {
        if(CollisionDataList.length >= 1) Text.innerText = "衝突がありました。";
      }
      
      for(let elem of CollisionDataList) {
        // 1. めり込みの解消 (位置修正)
        this.#miniResolvePenetration(elem.A, elem.B, elem.mtv);

        // 2. 衝突応答 (速度・角速度の更新)
        this.#miniResolveCollision(elem.A, elem.B, elem.contacts);
      }
    }
  }
}

CompVis.PhysicsObject = class {
  constructor({position,cor=1,noGravity=false,noCollision=false,mass=1,airResistance=0}={}) {
    this.position = position;
    this.cor = cor;
    this.noGravity = noGravity;
    this.noCollision = noCollision;
    this.mass = mass;
    this.airResistance = airResistance;
    this.velocity = new CompVis.Vector(0,0,0);
    this.angVelocity = new CompVis.Vector(0,0,0);
    this.force = new CompVis.Vector(0,0,0);
    this.torque = new CompVis.Vector(0,0,0);
  }
  
  get bounding() {
    throw new Error("get boundingは各形状ごとに実装してください。");
  }
  
  reset() {
    this.force = new CompVis.Vector(0,0,0);
    this.torque = new CompVis.Vector(0,0,0);
  }
  
  /*moveCalc(dt) {
    const a = this.force.scale(1/this.mass);
    this.velocity = this.velocity.add(a.scale(dt));
    this.position = this.position.add(this.velocity.scale(dt));
  }*/
}

CompVis.Box = class extends CompVis.PhysicsObject {
  constructor(unique, common) {
    super(common);
    this.halfSize = unique.halfSize;
    this.rotation = unique.rotation ?? new CompVis.Quater(1,0,0,0);
    this.boundingType = "box";
    this.inertia = unique.inertia ?? new CompVis.Matrix([
      [
        this.mass*(this.halfSize.y**2+this.halfSize.z**2)/3,0,0
      ],
      [
        0,this.mass*(this.halfSize.z**2+this.halfSize.x**2)/3,0
      ],
      [
        0,0,this.mass*(this.halfSize.x**2+this.halfSize.y**2)/3
      ]
    ]);
  }
  
  addForce(f) {
    this.force = this.force.add(f);
  }
  
  get vertex() {
    const s = this.halfSize;
    let ver = [
      new CompVis.Quater(0,-s.x,-s.y,-s.z),
      new CompVis.Quater(0,-s.x, s.y,-s.z),
      new CompVis.Quater(0,-s.x, s.y, s.z),
      new CompVis.Quater(0,-s.x,-s.y, s.z),
      new CompVis.Quater(0, s.x,-s.y,-s.z),
      new CompVis.Quater(0, s.x, s.y,-s.z),
      new CompVis.Quater(0, s.x, s.y, s.z),
      new CompVis.Quater(0, s.x,-s.y, s.z)
    ]
    const rot = this.rotation;
    const pos = new CompVis.Quater(this.position.values);
    return ver.map(Q => rot.pro(Q).pro(rot.inv).add(pos));
  }
  
  get bounding() {
    return {
      type: "box",
      vertex: this.vertex
    }
  }
  
  get axes() {
    const rot = this.rotation;
    return [
      rot.pro(new CompVis.Quater(0,1,0,0)).pro(rot.inv),
      rot.pro(new CompVis.Quater(0,0,1,0)).pro(rot.inv),
      rot.pro(new CompVis.Quater(0,0,0,1)).pro(rot.inv)
    ];
  }
  
  get getCollisionData() {
    const halfSize = this.halfSize; 
    // OBB軸 (半ベクトル)
    //const axes = this.axes.map(axis => new CompVis.Vector(axis.x*halfSize.x, axis.y*halfSize.y, axis.z*halfSize.z));
    const rot = this.rotation;
    const axes = [
      CompVis.QuaterToVector(rot.pro(new CompVis.Quater(0,halfSize.x,0,0)).pro(rot.inv)),
      CompVis.QuaterToVector(rot.pro(new CompVis.Quater(0,0,halfSize.y,0)).pro(rot.inv)),
      CompVis.QuaterToVector(rot.pro(new CompVis.Quater(0,0,0,halfSize.z)).pro(rot.inv))
    ];
  
    // 中心位置 (ベクトル)
    const position = this.position;
  
    return { axes, position };
    //return [this.axes.map(axis => new CompVis.Vector(axis.x,axis.y,axis.z)),this.position];
  }
  
  getFaceVertices(AxisVec) {
    const worldAxisQuat = new CompVis.Quater(AxisVec.values);
    const rot = this.rotation;
    // localAxisQuater
    const lAQ = CompVis.Quater.rotInv(rot,worldAxisQuat);
    // localAxisVec
    const lAV = new CompVis.Vector(lAQ.x, lAQ.y, lAQ.z);
    
    let fixed;
    
    const halfSize = [this.halfSize.x,this.halfSize.y,this.halfSize.z];
    
    let values = [
      lAV.x*this.halfSize.x,
      lAV.y*this.halfSize.y,
      lAV.z*this.halfSize.z
    ]
    
    const xyz = ["x","y","z"];
    
    let max = 0;let maxInd = 0;
    for(let ind = 0; ind < 3; ind++) {
      if(max < Math.abs(values[ind])) {
        maxInd = ind;
        max = Math.abs(values[ind]);
        fixed = new CompVis.Vector(0,0,0);
        fixed.setValue(ind,values[ind])
      }
    }
    
    const T1_ind = (maxInd + 1) % 3;
    const T2_ind = (maxInd + 2) % 3;
    
    // T1, T2 の長さは、対応する halfSize の成分そのもの
    const T1_h = halfSize[T1_ind];
    const T2_h = halfSize[T2_ind];
    
    
    // 3. ローカル頂点の計算 (4点生成)
    const localVertices = [];
    const t1_signs = [1, -1, -1, 1]; // +,-,-,+
    const t2_signs = [1, 1, -1, -1]; // +,-,-,+
    
    for (let i = 0; i < 4; i++) {
      // fixed をクローンし、そこから接線軸をずらす
      
      const localV = fixed.clone; 
      // T1 軸方向に加算
      localV.setValue(T1_ind, localV.getValue(T1_ind) + t1_signs[i] * T1_h);
        
       
     // T2 軸方向に加算
      localV.setValue(T2_ind, localV.getValue(T2_ind) + t2_signs[i] * T2_h);
        
      localVertices.push(localV);
    }
    
    const worldVertices = localVertices.map(v => {
      // ローカル -> ワールドへの回転 (Q * V_local * Q^-1)
      const v_quat = new CompVis.Quater(v.x, v.y, v.z);
      // rot.rot(Q, V) が Q * V * Q^-1 を正しく計算すると仮定
      
      const rotatedQ = CompVis.Quater.rot(rot, v_quat);
      
      const rotatedV = new CompVis.Vector(rotatedQ.x, rotatedQ.y, rotatedQ.z);
      
      //console.log("rotatedV (Position加算前):", rotatedV);
      // 位置を加算
      return rotatedV.add(this.position);
    });
    return worldVertices;
  }
  
  // CompVis.Box クラス内の moveCalc(dt) の最終修正

  moveCalc(dt) {
    if (this.mass <= 0) return;
    
    //console.log(this.force.str);

    const a = this.force.scale(1/this.mass);
    this.velocity = this.velocity.add(a.scale(dt));
    this.position = this.position.add(this.velocity.scale(dt));

    if (this.angVelocity && this.rotation && this.inertia._inverse) {
        const R_matrix = CompVis.QuaterToMatrix3x3(this.rotation); 
        const R_T_matrix = R_matrix.transpose; 
        const invInertiaWorld = R_matrix.pro(this.inertia._inverse).pro(R_T_matrix);
      
        const angularAcceleration = invInertiaWorld.mulVector(this.torque);
        this.angVelocity = this.angVelocity.add(angularAcceleration.scale(dt));

        const omegaQuat = new CompVis.Quater(0, this.angVelocity.x, this.angVelocity.y, this.angVelocity.z);
        const rotationDerivative = this.rotation.pro(omegaQuat).pro(0.5 * dt);
        
        this.rotation = this.rotation.add(rotationDerivative).normalize; 
    }
  }
}
