var txt = "";

function get_text(){
  txt = document.getElementByID("code_txt").innerText;
  alert(txt);
}

function main(){
  alert('hey');
  setTimeout(()=>{
    alert('3秒');
  },3000);
}

window.onload = function() {
  main()
}
