import * as THREE from 'three';
import { GLTFLoader } from 'GLTFLoader';
import { EffectComposer } from "EffectComposer";
import { RenderPass } from "RenderPass";
import { OutlinePass } from "OutlinePass";


window.onload = () => {
  const textDiv = document.getElementById("textDiv");
  const canvas = document.getElementById('three-canvas');
  const pointer = document.getElementById("pointer");
  
  const gaugeOut = document.getElementById("gauge-out");
  const gaugeIn = document.getElementById("gauge-in");
  
  const glbFiles = {
    'usually': 'https://mathotagamma.github.io/Statics/LIFESHAVE/usually.glb',
    'squat': 'https://mathotagamma.github.io/Statics/LIFESHAVE/squat.glb',
    'aim': 'https://mathotagamma.github.io/Statics/LIFESHAVE/aim.glb',
    'ready': 'https://mathotagamma.github.io/Statics/LIFESHAVE/ready.glb',
    'shooting': 'https://mathotagamma.github.io/Statics/LIFESHAVE/shooting.glb',
    'shooted': 'https://mathotagamma.github.io/Statics/LIFESHAVE/shooted.glb',
  }
  
  const glbData = {
    'usually': {size: {foot: 0.3, body: 0.83}, tall: 1.6},
    'squat': {size: {foot: 0.3, body: 0.83}, tall: 1.2},
    'aim': {size: {foot: 0.3, body: 0.83}, tall: 1.6},
    'ready': {size: {foot: 0.3, body: 0.83}, tall: 1.6},
    'shooting': {size: {foot: 0.3, body: 0.83}, tall: 1.6},
    'shooted': {size: {foot: 0.3, body: 0.83}, tall: 1.6}
  }

  
  // 1gridの一辺がgridSizeで、床エリアの一辺が1grid。
  // 床エリアと床エリアの間の長さを、gridSizeのgridGap個分として設定する。
  const gridSize = 6;
  const gridGap = 7;
  const Map = [
    [0,1,3,3,3,3,3,2,0],
    [0,1,1,1,3,2,2,2,0],
    [0,1,1,1,3,2,2,2,0],
    [1,1,1,1,3,2,2,2,2],
    [0,1,1,1,3,2,2,2,0],
    [0,1,1,1,3,2,2,2,0],
    [0,1,3,3,3,3,3,2,0],
  ]
  
  const modelMap = structuredClone(Map);
  
  const pillarSize = 1;
  let deltaTime = 0;
  
  let jumpOk = false;
  
  const scene = new THREE.Scene();

  const camera = new THREE.PerspectiveCamera(
    75,
    window.innerWidth / window.innerHeight,
    0.2,
    1000
  );

  const renderer = new THREE.WebGLRenderer({
    canvas: canvas,
    antialias: true
  });
  renderer.setSize(window.innerWidth, window.innerHeight);
  
  // composer
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  // --- 3人称視点用変数 ---
  const v = 5;
  const me = {
    // indexのride上での座標
    pos: new THREE.Vector3(0, 0, 0),
    kind: "usually",
    tall: NaN,
    sight: 1,
    color: 0xaaaa00,
    velocity: new THREE.Vector3(0, 0, 0),
    team: 1, // または2
    index: null,
  };
  
  me.pos = me.team == 1 ? new THREE.Vector3(0, 0, pillarSize / 2 + glbData[me.kind].size.body / 2) : new THREE.Vector3(0, 0, -pillarSize / 2 - glbData[me.kind].size.body / 2);
  
  me.index = [parseInt((Map.length-1) / 2), me.team == 1 ? 0 : parseInt(Map[(Map.length-1) / 2].length - 1)];
  
  me.tall = glbData[me.kind].tall;
  
  let dist = 3;
  let yaw = (me.sight == 1 ? Math.PI : 2*Math.PI) - (me.team == 1 ? Math.PI : 0);   // 水平方向
  let pitch = Math.PI/12; // 垂直方向
  
  
  const sensitivityMouse = 0.002;
  const sensitivityTouch = 0.005;
  
  window.Sight = function Sight() {
    me.sight = 4 - me.sight;
    yaw -= Math.PI;
  }
  
  
  const loader = new GLTFLoader();

  function loadGLB(url) {
    return new Promise((resolve, reject) => {
      const loader = new GLTFLoader();
      loader.load(
        url,
        (gltf) => resolve(gltf.scene),
        undefined,
        (err) => reject(err)
      );
    });
  }


  const models = {}; // 読み込んだモデル格納用
  
  function outlineView(model, color) {
    const pass = new OutlinePass(new THREE.Vector2(window.innerWidth, window.innerHeight), scene, camera, [model]);
    pass.visibleEdgeColor.set(color);
    pass.hiddenEdgeColor.set(color);
    composer.addPass(pass);
  }

  Promise.all(
    Object.entries(glbFiles).map(([name, url]) =>
      loadGLB(url).then(model => {
        models[name] = model;
      })
    )
  ).then(() => {
    if (models[me.kind]) {
      const model = models[me.kind].clone(); // 複製してシーンに追加
      model.position.copy(me.pos);
      scene.add(model);
      model.traverse((child) => {
        if (child.isMesh) {
          const mat = child.material;
          if (mat.isMeshStandardMaterial) {
            mat.emissive = new THREE.Color(me.color); // 発光色
            mat.emissiveIntensity = 0.9; // 発光強度
          }
        }
      });
      me.model = model; // me にモデル参照を持たせると更新や移動が可能
      
      if(me.team == 1) {
        outlineView(model, 0xff0000);
      } else if(me.team == 2) {
        outlineView(model, 0x0000ff);
      }
    }
  })
  .catch(err => console.error('GLB読み込み失敗', err));

  
  function indexToPos(row, col) {
    return [(-(Map.length-1)/2 + row)*(gridGap+1)*gridSize, (-(Map[row].length-1)/2 + col)*(gridGap+1)*gridSize];
  }

  
  function rideView(){
    for(let row = 0; row < Map.length; row++){
      for(let col = 0; col < Map[row].length; col++){
        if(Map[row][col] == 0) continue;
        
        const pos = indexToPos(row, col);
        
        const floor = new THREE.Mesh(
          new THREE.BoxGeometry(gridSize, 1, gridSize),
          new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true })
        );
        
        floor.position.set(pos[0], -0.5, pos[1]);
        scene.add(floor);
        
        let color = 0x00ff00;
        if(Map[row][col] == 1){
          color = 0xff0000;
        } else if(Map[row][col] == 2){
          color = 0x0000ff;
        }
        
        const pillar = new THREE.Mesh(
          new THREE.BoxGeometry(pillarSize, 6, pillarSize),
          new THREE.MeshBasicMaterial({ color: color, wireframe: true })
        );
        
        pillar.position.set(pos[0], 3, pos[1]);
        scene.add(pillar);
        
        modelMap[row][col] = {floor: floor, pillar: pillar}
      }
    }
  }

  rideView();
  
  
  

  // --- マウス操作 ---
  window.addEventListener('mousemove', (e) => {
    if (document.pointerLockElement === canvas) {
      yaw -= e.movementX * sensitivityMouse;
      pitch += e.movementY * sensitivityMouse;
      clampPitch();
    }
  });
  
  if (canvas.requestPointerLock) {
    canvas.addEventListener('click', () => {
      canvas.requestPointerLock();
    });
  } else {
    console.warn('Pointer Lock API is not supported in this browser.');
  }

  // --- タッチ操作 ---
  const touchList = {};
  let leftTouch = false;
  let rightTouch = false;
  
  
  const moveOut = document.getElementById("move-out");
  const moveIn = document.getElementById("move-in");
  
  let jumpTimer = NaN;

  canvas.addEventListener('touchstart', (e) => {
    for (let i = 0; i < e.changedTouches.length; i++) {
      if(leftTouch && e.changedTouches[i].clientX < innerWidth / 2) continue;
      if(rightTouch && e.changedTouches[i].clientX > innerWidth / 2) continue;
      if(e.changedTouches[i].clientX < innerWidth / 2) {
        leftTouch = true;
        touchList[e.changedTouches[i].identifier] = {
          startPos: [e.changedTouches[i].clientX, e.changedTouches[i].clientY],
          lastPos: [e.changedTouches[i].clientX, e.changedTouches[i].clientY],
          side: "left",
        }
        
        moveOut.style.left = e.changedTouches[i].clientX+"px";
        moveOut.style.bottom = (innerHeight - e.changedTouches[i].clientY)+"px";
        moveIn.style.left = "0px";
        moveIn.style.top = "0px";
        moveOut.style.display = "block";
      }
      if(e.changedTouches[i].clientX > innerWidth / 2) {
        rightTouch = true;
        touchList[e.changedTouches[i].identifier] = {
          startPos: [e.changedTouches[i].clientX, e.changedTouches[i].clientY],
          lastPos: [e.changedTouches[i].clientX, e.changedTouches[i].clientY],
          side: "right",
        }
        
        if(jumpOk) jumpTimer = Date.now();
      }
    }
  });

  canvas.addEventListener('touchmove', (e) => {
    for(let k = 0; k < e.touches.length; k++) {
      if(!Object.keys(touchList).includes(String(e.touches[k].identifier))) continue;
      const touchData = touchList[e.touches[k].identifier];
      
      
      if(touchData.startPos[0] < innerWidth / 2) {
        const moveButtonSize = parseInt(String(getComputedStyle(moveOut).getPropertyValue('--size')).trim().replace("px", ""))/2;

        const mult = Math.min(moveButtonSize/((touchData.lastPos[0]-touchData.startPos[0])**2+(touchData.lastPos[1]-touchData.startPos[1])**2)**0.5, 1);
        
        const X = mult * (touchData.lastPos[0]-touchData.startPos[0])/moveButtonSize;
        const Z = mult * (touchData.lastPos[1]-touchData.startPos[1])/moveButtonSize;
        
        let sign = 1;
        if(me.sight == 1) {
          sign = -1;
        }
        me.velocity = new THREE.Vector3(sign * v * (X * Math.cos(yaw) + Z *Math.sin(yaw)), 0, sign * v * (-X * Math.sin(yaw) + Z * Math.cos(yaw)));
        
        moveIn.style.left = String(Math.round(moveButtonSize * X))+"px";
        moveIn.style.top = String(Math.round(moveButtonSize * Z))+"px";
      } else if(touchData.startPos[0] > innerWidth / 2) {
        const dx = e.touches[k].clientX - touchData.lastPos[0];
        const dy = e.touches[k].clientY - touchData.lastPos[1];
      
        yaw -= dx * sensitivityTouch;
        pitch += dy * sensitivityTouch;
        clampPitch();
      }
      
      touchList[e.touches[k].identifier].lastPos = [e.touches[k].clientX, e.touches[k].clientY];
    }
  });
  
  canvas.addEventListener('touchend', (e) => {
    for(let k = 0; k < e.changedTouches.length; k++) {
      if(!Object.keys(touchList).includes(String(e.changedTouches[k].identifier))) continue;
      if(touchList[e.changedTouches[k].identifier].side == "left") {
        moveOut.style.display = "none";
        me.velocity.x = 0;
        me.velocity.z = 0;
        leftTouch = false;
      }
      if(touchList[e.changedTouches[k].identifier].side == "right") {
        rightTouch = false;
        if(jumpOk && !Number.isNaN(jumpTimer) && Date.now() - jumpTimer > 1000 * jumpOk[3]) {
          jump();
        }
        jumpTimer = NaN;
      }
      delete touchList[e.changedTouches[k].identifier];
    }
    if(e.touches.length == 0) {
      leftTouch = false;
      rightTouch = false;
      for(const k of Object.keys(touchList)) {
        delete touchList[k];
      }
    }
  });
  
  function jump() {
    me.index[0] += jumpOk[0];
    me.index[1] += jumpOk[1];
  }

  function clampPitch() {
    const limit = Math.PI / 2 - 0.01;
    if (pitch > limit) pitch = limit;
    if (pitch < -limit) pitch = -limit;
  }
  
  function updateMe() {
    const prePos = me.pos;
    
    me.pos.x += me.velocity.x * deltaTime;
    me.pos.x = Math.min(gridSize/2-glbData[me.kind].size.foot/2, Math.max(-gridSize/2+glbData[me.kind].size.foot/2, me.pos.x));
    
    me.pos.y += me.velocity.y * deltaTime;
    
    me.pos.z += me.velocity.z * deltaTime;
    me.pos.z = Math.min(gridSize/2-glbData[me.kind].size.foot/2, Math.max(-gridSize/2+glbData[me.kind].size.foot/2, me.pos.z));
    
    if(Math.abs(prePos.x) < pillarSize/2+glbData[me.kind].size.body/2 && Math.abs(prePos.z) < pillarSize/2+glbData[me.kind].size.body/2){
      // up
      if(me.pos.z > me.pos.x && me.pos.z > -me.pos.x) {
        me.pos.z = pillarSize/2+glbData[me.kind].size.body/2;
      // right
      } else if(me.pos.z < me.pos.x && me.pos.z > -me.pos.x) {
        me.pos.x = pillarSize/2+glbData[me.kind].size.body/2;
      // bottom
      } else if(me.pos.z < me.pos.x && me.pos.z < -me.pos.x) {
        me.pos.z = -pillarSize/2-glbData[me.kind].size.body/2;
      // left
      } else if(me.pos.z > me.pos.x && me.pos.z < -me.pos.x) {
        me.pos.x = -pillarSize/2-glbData[me.kind].size.body/2;
      }
    }
    
    if(me.model) {
      const pos = indexToPos(me.index[0], me.index[1]);
      me.model.position.set(me.pos.x + pos[0], me.pos.y, me.pos.z + pos[1]);
      if(me.sight == 3){
        me.model.rotation.y = yaw + Math.PI;
      } else if(me.sight == 1){
        me.model.rotation.y = yaw;
      }
    }
  }

  function updateCamera() {
    const pos = indexToPos(me.index[0], me.index[1]);
    if(me.sight == 3){
      pointer.style.display = "none";
      // yaw/pitch からカメラ位置を計算
      const x = me.pos.x + dist * Math.cos(pitch) * Math.sin(yaw) + pos[0];
      const y = me.tall + me.pos.y + dist * Math.sin(pitch);
      const z = me.pos.z + dist * Math.cos(pitch) * Math.cos(yaw) + pos[1];

      camera.position.set(x, y, z);
      camera.lookAt(new THREE.Vector3(me.pos.x + pos[0], me.tall + me.pos.y, me.pos.z + pos[1]));
    } else if(me.sight == 1){
      pointer.style.display = "block";
      const x = me.pos.x + dist * Math.cos(pitch) * Math.sin(yaw) + pos[0];
      const y = me.tall + me.pos.y - dist * Math.sin(pitch);
      const z = me.pos.z + dist * Math.cos(pitch) * Math.cos(yaw) + pos[1];
      camera.position.set(me.pos.x + pos[0], me.tall + me.pos.y, me.pos.z + pos[1]);
      camera.lookAt(new THREE.Vector3(x, y, z));
    }
  }
  
  function calcState() {
    if(me.sight == 1 & Math.abs(pitch + Math.PI/18) < Math.PI/40) {
      const sightRange = 0.995;
      
      if(Math.cos(yaw) > sightRange) {
        jumpOk = [0, 1];
      } else if(Math.sin(yaw) > sightRange) {
        jumpOk = [1, 0];
      } else if(Math.cos(yaw) < -sightRange) {
        jumpOk = [0, -1];
      } else if(Math.sin(yaw) < -sightRange) {
        jumpOk = [-1, 0];
      } else {
        jumpOk = false;
      }
    } else {
      jumpOk = false;
    }
    
    document.documentElement.style.setProperty("--pointer-color", "white");
    if(jumpOk) {
      const row = me.index[0] + jumpOk[0];
      const col = me.index[1] + jumpOk[1];
      
      if(row < 0 || col < 0 || row >= Map.length || col >= Map[row].length){
        jumpOk = false;
      } else {
        const kind = Map[row][col];
        switch (kind) {
          case 0:
            jumpOk = false;
            break;
          case 1:
            document.documentElement.style.setProperty("--pointer-color", "#FF0000");
            jumpOk.push(1);
            jumpOk.push(me.team == 1 ? 1 : 5);
            break;
          case 2:
            document.documentElement.style.setProperty("--pointer-color", "#0000FF");
            jumpOk.push(2);
            jumpOk.push(me.team == 2 ? 1 : 5);
            break;
          case 3:
            document.documentElement.style.setProperty("--pointer-color", "#00FF00");
            jumpOk.push(3);
            jumpOk.push(3);
            break;
        }
      }
    }
    if(!jumpOk) {
      gaugeOut.style.display = "none";
      jumpTimer = NaN;
    } else {
      
      if(!Number.isNaN(jumpTimer)) {
        gaugeOut.style.display = "block";
        gaugeIn.style.background = "#44CC44";
        gaugeIn.style.width = String(Math.min(100, (Date.now() - jumpTimer) / 10 / jumpOk[3])) + "%";
      } else {
        gaugeOut.style.display = "none";
        jumpTimer = NaN;
      }
    }
  }
  
  
  let startTime = null;
  let preTime = null;

  function animate() {
    requestAnimationFrame(animate);
    if(preTime == null) {
      startTime = Date.now();
      preTime = startTime;
    }
    deltaTime = (Date.now() - preTime) / 1000;
    preTime = Date.now();
    updateMe();
    updateCamera();
    calcState();
    renderer.render(scene, camera);
    composer.render();
    
    textDiv.textContent = String((Date.now() - startTime)/1000)+"秒";
  }
  animate();
  
  

  // リサイズ対応
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    composer.setSize(window.innerWidth, window.innerHeight);
  });
};
